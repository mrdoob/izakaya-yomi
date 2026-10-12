// English meanings from JMdict (see scripts/build-jmdict.mjs for the file format).

import { fetchWithProgress } from './fetch.js';

let lines = null;
let index = null;
const parsed = new Map();

async function gunzip( bytes ) {

	// Some servers send .gz files with Content-Encoding: gzip, in which case fetch() already decompressed it.
	if ( bytes[ 0 ] !== 0x1f || bytes[ 1 ] !== 0x8b ) return bytes;

	const stream = new Blob( [ bytes ] ).stream().pipeThrough( new DecompressionStream( 'gzip' ) );
	return new Uint8Array( await new Response( stream ).arrayBuffer() );

}

export async function loadDictionary( onProgress = () => {} ) {

	const bytes = await gunzip( await fetchWithProgress( new URL( '../data/jmdict-eng.txt.gz', import.meta.url ), onProgress ) );
	const text = new TextDecoder().decode( bytes );

	lines = text.split( '\n' ).filter( line => line !== '' && ! line.startsWith( '#' ) );
	index = new Map();

	for ( let i = 0; i < lines.length; i ++ ) {

		const line = lines[ i ];
		const kanjiEnd = line.indexOf( '\t' );
		const kanaEnd = line.indexOf( '\t', kanjiEnd + 1 );
		const forms = line.slice( 0, kanjiEnd ).split( '\x1f' );

		for ( const kana of line.slice( kanjiEnd + 1, kanaEnd ).split( '\x1f' ) ) {

			forms.push( kana.replace( /\[.*$/, '' ) );

		}

		for ( const form of forms ) {

			if ( form === '' ) continue;
			const entries = index.get( form );
			if ( entries === undefined ) index.set( form, [ i ] );
			else if ( entries[ entries.length - 1 ] !== i ) entries.push( i );

		}

	}

}

function entry( i ) {

	let result = parsed.get( i );
	if ( result ) return result;

	const [ kanji, kana, common, senses ] = lines[ i ].split( '\t' );

	result = {
		kanji: kanji === '' ? [] : kanji.split( '\x1f' ),
		kana: kana.split( '\x1f' ).map( k => {

			const match = k.match( /^(.*?)(?:\[(.*)\])?$/ );
			return { text: match[ 1 ], appliesTo: match[ 2 ] === undefined ? null : match[ 2 ] === '' ? [] : match[ 2 ].split( '|' ) };

		} ),
		common: common === '1',
		senses: senses.split( '\x1e' )
	};

	parsed.set( i, result );
	return result;

}

export function has( form ) {

	return index !== null && index.has( form );

}

// Readings (hiragana or katakana as written in JMdict) that apply to a written form.

function readingsFor( e, form ) {

	if ( ! e.kanji.includes( form ) ) return [ form ];
	return e.kana.filter( k => k.appliesTo === null || k.appliesTo.includes( form ) ).map( k => k.text );

}

function toHiragana( text ) {

	return text.replace( /[ァ-ヶ]/g, c => String.fromCharCode( c.charCodeAt( 0 ) - 0x60 ) );

}

// Best entry for a written form, preferring the given reading and common words.
// Returns { reading, senses } or null.

export function lookup( form, reading = null ) {

	if ( index === null ) return null;

	const entries = ( index.get( form ) ?? [] ).map( entry );
	if ( entries.length === 0 ) return null;

	const score = e => {

		const readings = readingsFor( e, form ).map( toHiragana );
		return ( reading !== null && readings.includes( toHiragana( reading ) ) ? 2 : 0 ) + ( e.common ? 1 : 0 );

	};

	let best = entries[ 0 ];
	for ( const e of entries ) if ( score( e ) > score( best ) ) best = e;

	const readings = readingsFor( best, form );
	const matching = reading !== null && readings.find( r => toHiragana( r ) === toHiragana( reading ) );

	return { reading: toHiragana( matching || readings[ 0 ] ), senses: best.senses };

}
