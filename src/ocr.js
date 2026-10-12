// PP-OCRv5 (mobile) text detection + recognition running on onnxruntime-web.

import * as ort from '../vendor/ort/ort.webgpu.min.mjs';
import { fetchWithProgress } from './fetch.js';

ort.env.wasm.wasmPaths = new URL( '../vendor/ort/', import.meta.url ).href;
ort.env.logLevel = 'error';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min( 4, navigator.hardwareConcurrency || 1 ) : 1;

const DET_LONG_SIDE = 1280;
const DET_THRESH = 0.3;
const DET_BOX_THRESH = 0.6;
const DET_UNCLIP_RATIO = 1.5;
const DET_MIN_SIZE = 3;
const DET_MEAN = [ 0.485, 0.456, 0.406 ];
const DET_STD = [ 0.229, 0.224, 0.225 ];

const REC_HEIGHT = 48;
const REC_MIN_WIDTH = 320;
const REC_MAX_WIDTH = 3200;

let detSession = null;
let recSession = null;
let dictionary = null;

export async function loadOCR( onProgress = () => {} ) {

	const base = new URL( '../models/', import.meta.url );
	const progress = { det: [ 0, 0 ], rec: [ 0, 0 ] };
	const report = () => {

		const loaded = progress.det[ 0 ] + progress.rec[ 0 ];
		const total = progress.det[ 1 ] + progress.rec[ 1 ];
		onProgress( loaded, total );

	};

	const [ detModel, recModel, dictText ] = await Promise.all( [
		fetchWithProgress( new URL( 'det.onnx', base ), ( l, t ) => { progress.det = [ l, t ]; report(); } ),
		fetchWithProgress( new URL( 'rec.onnx', base ), ( l, t ) => { progress.rec = [ l, t ]; report(); } ),
		fetch( new URL( 'rec_dict.txt', base ) ).then( r => r.text() )
	] );

	dictionary = dictText.replace( /\n$/, '' ).split( '\n' );

	const params = new URLSearchParams( location.search );
	const executionProviders = params.get( 'ep' ) === 'wasm' || ! navigator.gpu ? [ 'wasm' ] : [ 'webgpu', 'wasm' ];
	const options = { executionProviders, graphOptimizationLevel: 'all' };

	detSession = await ort.InferenceSession.create( detModel, options );
	recSession = await ort.InferenceSession.create( recModel, options );

	return executionProviders[ 0 ];

}

// Image helpers

function getImageData( source, width, height ) {

	const canvas = new OffscreenCanvas( width, height );
	const context = canvas.getContext( '2d', { willReadFrequently: true } );
	context.imageSmoothingQuality = 'high';
	context.drawImage( source, 0, 0, width, height );
	return context.getImageData( 0, 0, width, height );

}

// Detection

async function detect( canvas ) {

	const scale = DET_LONG_SIDE / Math.max( canvas.width, canvas.height );
	const width = Math.max( 32, Math.round( canvas.width * scale / 32 ) * 32 );
	const height = Math.max( 32, Math.round( canvas.height * scale / 32 ) * 32 );

	const { data } = getImageData( canvas, width, height );
	const size = width * height;
	const input = new Float32Array( 3 * size );

	// BGR order, as the model was trained with OpenCV images.
	for ( let i = 0; i < size; i ++ ) {

		const r = data[ i * 4 ] / 255;
		const g = data[ i * 4 + 1 ] / 255;
		const b = data[ i * 4 + 2 ] / 255;
		input[ i ] = ( b - DET_MEAN[ 0 ] ) / DET_STD[ 0 ];
		input[ size + i ] = ( g - DET_MEAN[ 1 ] ) / DET_STD[ 1 ];
		input[ 2 * size + i ] = ( r - DET_MEAN[ 2 ] ) / DET_STD[ 2 ];

	}

	const feeds = { [ detSession.inputNames[ 0 ] ]: new ort.Tensor( 'float32', input, [ 1, 3, height, width ] ) };
	const results = await detSession.run( feeds );
	const output = results[ detSession.outputNames[ 0 ] ];
	const prob = await output.getData();
	output.dispose?.();

	const sx = canvas.width / width;
	const sy = canvas.height / height;

	return findBoxes( prob, width, height ).map( box => box.map( ( [ x, y ] ) => [ x * sx, y * sy ] ) );

}

function findBoxes( prob, width, height ) {

	const size = width * height;
	const visited = new Uint8Array( size );
	const stack = new Int32Array( size );
	const rowMin = new Int32Array( height ).fill( width );
	const rowMax = new Int32Array( height ).fill( - 1 );
	const boxes = [];

	for ( let start = 0; start < size; start ++ ) {

		if ( visited[ start ] || prob[ start ] <= DET_THRESH ) continue;

		// Flood fill one connected component (8-connectivity).

		let top = 0;
		stack[ top ++ ] = start;
		visited[ start ] = 1;

		let count = 0;
		let sum = 0;
		let minY = height;
		let maxY = - 1;

		while ( top > 0 ) {

			const index = stack[ -- top ];
			const x = index % width;
			const y = ( index - x ) / width;

			count ++;
			sum += prob[ index ];
			if ( x < rowMin[ y ] ) rowMin[ y ] = x;
			if ( x > rowMax[ y ] ) rowMax[ y ] = x;
			if ( y < minY ) minY = y;
			if ( y > maxY ) maxY = y;

			for ( let dy = - 1; dy <= 1; dy ++ ) {

				const ny = y + dy;
				if ( ny < 0 || ny >= height ) continue;

				for ( let dx = - 1; dx <= 1; dx ++ ) {

					const nx = x + dx;
					if ( nx < 0 || nx >= width ) continue;

					const next = ny * width + nx;
					if ( visited[ next ] || prob[ next ] <= DET_THRESH ) continue;
					visited[ next ] = 1;
					stack[ top ++ ] = next;

				}

			}

		}

		// The convex hull of a component only depends on the extremes of each row.

		const points = [];

		for ( let y = minY; y <= maxY; y ++ ) {

			if ( rowMax[ y ] >= 0 ) {

				points.push( [ rowMin[ y ], y ], [ rowMax[ y ] + 1, y ], [ rowMin[ y ], y + 1 ], [ rowMax[ y ] + 1, y + 1 ] );

			}

			rowMin[ y ] = width;
			rowMax[ y ] = - 1;

		}

		if ( count < 4 || sum / count < DET_BOX_THRESH ) continue;

		const rect = minAreaRect( convexHull( points ) );
		if ( Math.min( rect.w, rect.h ) < DET_MIN_SIZE ) continue;

		const distance = rect.w * rect.h * DET_UNCLIP_RATIO / ( 2 * ( rect.w + rect.h ) );
		rect.w += 2 * distance;
		rect.h += 2 * distance;
		if ( Math.min( rect.w, rect.h ) < DET_MIN_SIZE + 2 ) continue;

		boxes.push( rectToQuad( rect ) );
		if ( boxes.length >= 1000 ) break;

	}

	return boxes;

}

function convexHull( points ) {

	points.sort( ( a, b ) => a[ 0 ] - b[ 0 ] || a[ 1 ] - b[ 1 ] );

	const cross = ( o, a, b ) => ( a[ 0 ] - o[ 0 ] ) * ( b[ 1 ] - o[ 1 ] ) - ( a[ 1 ] - o[ 1 ] ) * ( b[ 0 ] - o[ 0 ] );
	const lower = [];
	const upper = [];

	for ( const p of points ) {

		while ( lower.length >= 2 && cross( lower[ lower.length - 2 ], lower[ lower.length - 1 ], p ) <= 0 ) lower.pop();
		lower.push( p );

	}

	for ( let i = points.length - 1; i >= 0; i -- ) {

		const p = points[ i ];
		while ( upper.length >= 2 && cross( upper[ upper.length - 2 ], upper[ upper.length - 1 ], p ) <= 0 ) upper.pop();
		upper.push( p );

	}

	lower.pop();
	upper.pop();
	return lower.concat( upper );

}

function minAreaRect( hull ) {

	let best = null;

	for ( let i = 0; i < hull.length; i ++ ) {

		const a = hull[ i ];
		const b = hull[ ( i + 1 ) % hull.length ];
		const length = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
		if ( length === 0 ) continue;

		const ux = ( b[ 0 ] - a[ 0 ] ) / length;
		const uy = ( b[ 1 ] - a[ 1 ] ) / length;

		let minU = Infinity, maxU = - Infinity, minV = Infinity, maxV = - Infinity;

		for ( const [ x, y ] of hull ) {

			const u = x * ux + y * uy;
			const v = - x * uy + y * ux;
			if ( u < minU ) minU = u;
			if ( u > maxU ) maxU = u;
			if ( v < minV ) minV = v;
			if ( v > maxV ) maxV = v;

		}

		const area = ( maxU - minU ) * ( maxV - minV );

		if ( best === null || area < best.area ) {

			const cu = ( minU + maxU ) / 2;
			const cv = ( minV + maxV ) / 2;
			best = {
				area,
				cx: cu * ux - cv * uy,
				cy: cu * uy + cv * ux,
				ux, uy,
				w: maxU - minU,
				h: maxV - minV
			};

		}

	}

	return best;

}

// Returns corners [tl, tr, br, bl], with the first edge being the one closest to horizontal.

function rectToQuad( { cx, cy, ux, uy, w, h } ) {

	if ( Math.abs( ux ) < Math.abs( uy ) ) {

		[ ux, uy ] = [ - uy, ux ];
		[ w, h ] = [ h, w ];

	}

	if ( ux < 0 ) {

		ux = - ux;
		uy = - uy;

	}

	const vx = - uy;
	const vy = ux;
	const hw = w / 2;
	const hh = h / 2;

	return [
		[ cx - ux * hw - vx * hh, cy - uy * hw - vy * hh ],
		[ cx + ux * hw - vx * hh, cy + uy * hw - vy * hh ],
		[ cx + ux * hw + vx * hh, cy + uy * hw + vy * hh ],
		[ cx - ux * hw + vx * hh, cy - uy * hw + vy * hh ]
	];

}

// Recognition

// Samples the parallelogram origin + s * ex + t * ey (s, t in [0, 1]) into the
// [3, REC_HEIGHT, tensorWidth] tensor at column offsetX, with the given output width.

function sampleInto( tensor, tensorWidth, offsetX, outWidth, image, origin, ex, ey ) {

	const { data, width, height } = image;
	const plane = REC_HEIGHT * tensorWidth;

	const lengthX = Math.hypot( ex[ 0 ], ex[ 1 ] );
	const lengthY = Math.hypot( ey[ 0 ], ey[ 1 ] );
	const samples = Math.min( 4, Math.max( 1, Math.ceil( Math.max( lengthX / outWidth, lengthY / REC_HEIGHT ) ) ) );
	const weight = 1 / ( samples * samples * 255 );

	for ( let y = 0; y < REC_HEIGHT; y ++ ) {

		for ( let x = 0; x < outWidth; x ++ ) {

			let r = 0, g = 0, b = 0;

			for ( let j = 0; j < samples; j ++ ) {

				const t = ( y + ( j + 0.5 ) / samples ) / REC_HEIGHT;

				for ( let i = 0; i < samples; i ++ ) {

					const s = ( x + ( i + 0.5 ) / samples ) / outWidth;
					const px = Math.min( width - 1.001, Math.max( 0, origin[ 0 ] + s * ex[ 0 ] + t * ey[ 0 ] - 0.5 ) );
					const py = Math.min( height - 1.001, Math.max( 0, origin[ 1 ] + s * ex[ 1 ] + t * ey[ 1 ] - 0.5 ) );

					const x0 = Math.floor( px );
					const y0 = Math.floor( py );
					const fx = px - x0;
					const fy = py - y0;
					const i00 = ( y0 * width + x0 ) * 4;
					const i10 = i00 + 4;
					const i01 = i00 + width * 4;
					const i11 = i01 + 4;
					const w00 = ( 1 - fx ) * ( 1 - fy );
					const w10 = fx * ( 1 - fy );
					const w01 = ( 1 - fx ) * fy;
					const w11 = fx * fy;

					r += data[ i00 ] * w00 + data[ i10 ] * w10 + data[ i01 ] * w01 + data[ i11 ] * w11;
					g += data[ i00 + 1 ] * w00 + data[ i10 + 1 ] * w10 + data[ i01 + 1 ] * w01 + data[ i11 + 1 ] * w11;
					b += data[ i00 + 2 ] * w00 + data[ i10 + 2 ] * w10 + data[ i01 + 2 ] * w01 + data[ i11 + 2 ] * w11;

				}

			}

			const index = y * tensorWidth + offsetX + x;
			tensor[ index ] = b * weight * 2 - 1;
			tensor[ plane + index ] = g * weight * 2 - 1;
			tensor[ 2 * plane + index ] = r * weight * 2 - 1;

		}

	}

}

function tensorWidthFor( contentWidth ) {

	const width = Math.max( REC_MIN_WIDTH, contentWidth );
	return Math.min( REC_MAX_WIDTH, Math.ceil( width / 64 ) * 64 );

}

async function recognizeTensor( tensor, width ) {

	const feeds = { [ recSession.inputNames[ 0 ] ]: new ort.Tensor( 'float32', tensor, [ 1, 3, REC_HEIGHT, width ] ) };
	const results = await recSession.run( feeds );
	const output = results[ recSession.outputNames[ 0 ] ];
	const [ , steps, classes ] = output.dims;
	const probs = await output.getData();
	output.dispose?.();

	// Greedy CTC decoding. Class 0 is the blank, the last class is a space.

	let text = '';
	let confidence = 0;
	let count = 0;
	let previous = 0;

	for ( let t = 0; t < steps; t ++ ) {

		let best = 0;
		let bestProb = - Infinity;
		const offset = t * classes;

		for ( let c = 0; c < classes; c ++ ) {

			if ( probs[ offset + c ] > bestProb ) {

				bestProb = probs[ offset + c ];
				best = c;

			}

		}

		if ( best !== 0 && best !== previous ) {

			text += best <= dictionary.length ? dictionary[ best - 1 ] : ' ';
			confidence += bestProb;
			count ++;

		}

		previous = best;

	}

	return { text: text.trim(), confidence: count > 0 ? confidence / count : 0 };

}

// Horizontal text: the crop is fed as is.

async function recognizeHorizontal( image, quad ) {

	const [ tl, tr, , bl ] = quad;
	const ex = [ tr[ 0 ] - tl[ 0 ], tr[ 1 ] - tl[ 1 ] ];
	const ey = [ bl[ 0 ] - tl[ 0 ], bl[ 1 ] - tl[ 1 ] ];
	const outWidth = Math.min( REC_MAX_WIDTH, Math.max( 1, Math.round( REC_HEIGHT * Math.hypot( ...ex ) / Math.hypot( ...ey ) ) ) );
	const width = tensorWidthFor( outWidth );
	const tensor = new Float32Array( 3 * REC_HEIGHT * width );

	sampleInto( tensor, width, 0, outWidth, image, tl, ex, ey );
	return recognizeTensor( tensor, width );

}

// Vertical text, rotated 90° counter-clockwise. PP-OCRv5 is trained on vertical text this way.

async function recognizeRotated( image, quad ) {

	const [ tl, tr, br ] = quad;
	return recognizeHorizontal( image, [ tr, br, quad[ 3 ], tl ] );

}

// Kanji that look like katakana get mixed up next to katakana: 口ック → ロック, 力ツ → カツ.

const KATAKANA_LOOKALIKES = { 口: 'ロ', 一: 'ー', 力: 'カ', 工: 'エ', 二: 'ニ', 八: 'ハ', 卜: 'ト', 夕: 'タ' };

function fixKatakana( text ) {

	const isKatakana = char => char !== undefined && /[ァ-ヶー]/.test( char );
	const chars = [ ...text ];

	for ( let i = 0; i < chars.length; i ++ ) {

		const replacement = KATAKANA_LOOKALIKES[ chars[ i ] ];
		if ( replacement && ( isKatakana( chars[ i - 1 ] ) || isKatakana( chars[ i + 1 ] ) ) ) chars[ i ] = replacement;

	}

	return chars.join( '' );

}

// Reading order: vertical columns right to left, horizontal lines top to bottom.

function sortLines( lines ) {

	const center = quad => [
		( quad[ 0 ][ 0 ] + quad[ 2 ][ 0 ] ) / 2,
		( quad[ 0 ][ 1 ] + quad[ 2 ][ 1 ] ) / 2
	];

	return lines.sort( ( a, b ) => {

		const [ ax, ay ] = center( a.quad );
		const [ bx, by ] = center( b.quad );
		const ah = Math.min( a.size[ 0 ], a.size[ 1 ] );
		const bh = Math.min( b.size[ 0 ], b.size[ 1 ] );

		if ( a.vertical && b.vertical ) return bx - ax;

		const top = quad => Math.min( ...quad.map( p => p[ 1 ] ) );
		const tolerance = Math.max( ah, bh ) / 2;
		if ( Math.abs( top( a.quad ) - top( b.quad ) ) > tolerance ) return top( a.quad ) - top( b.quad );
		if ( a.vertical !== b.vertical ) return ay - by;

		return ax - bx;

	} );

}

export async function recognize( canvas, onProgress = () => {} ) {

	const image = canvas.getContext( '2d' ).getImageData( 0, 0, canvas.width, canvas.height );
	const quads = await detect( canvas );
	const lines = [];

	for ( let i = 0; i < quads.length; i ++ ) {

		onProgress( i, quads.length );

		const quad = quads[ i ];
		const w = Math.hypot( quad[ 1 ][ 0 ] - quad[ 0 ][ 0 ], quad[ 1 ][ 1 ] - quad[ 0 ][ 1 ] );
		const h = Math.hypot( quad[ 3 ][ 0 ] - quad[ 0 ][ 0 ], quad[ 3 ][ 1 ] - quad[ 0 ][ 1 ] );
		const vertical = h / w >= 1.5;

		const result = vertical ? await recognizeRotated( image, quad ) : await recognizeHorizontal( image, quad );

		if ( result.text === '' || result.confidence < 0.5 ) continue;

		lines.push( { quad, size: [ w, h ], vertical, text: fixKatakana( result.text ), confidence: result.confidence } );

	}

	onProgress( quads.length, quads.length );

	return sortLines( lines );

}
