import { loadOCR, recognize } from './ocr.js';
import { loadReading, annotate, toHiragana } from './reading.js';
import { loadDictionary } from './dictionary.js';

const MAX_IMAGE_SIDE = 2048;

const $ = selector => document.querySelector( selector );

const status = $( '#status' );
const statusText = $( '#status-text' );
const statusBar = $( '#status-bar' );
const intro = $( '#intro' );
const viewer = $( '#viewer' );
const photo = $( '#photo' );
const overlay = $( '#overlay' );
const sheet = $( '#sheet' );
const card = $( '#card' );

// Service worker: offline cache and cross-origin isolation (multithreaded WASM).

if ( 'serviceWorker' in navigator ) {

	navigator.serviceWorker.register( './sw.js' ).then( registration => {

		if ( ! self.crossOriginIsolated && registration.active && ! sessionStorageGet( 'coi-reloaded' ) ) {

			sessionStorageSet( 'coi-reloaded', '1' );
			location.reload();

		}

	} ).catch( error => console.warn( 'Service worker not available, offline mode is disabled.', error ) );

	navigator.serviceWorker.addEventListener( 'controllerchange', () => {

		if ( ! self.crossOriginIsolated && ! sessionStorageGet( 'coi-reloaded' ) ) {

			sessionStorageSet( 'coi-reloaded', '1' );
			location.reload();

		}

	} );

}

function sessionStorageGet( key ) {

	try { return sessionStorage.getItem( key ); } catch { return null; }

}

function sessionStorageSet( key, value ) {

	try { sessionStorage.setItem( key, value ); } catch { /* ignore */ }

}

// Status

let failed = false;

function setStatus( text, progress = null ) {

	if ( failed ) return;

	status.hidden = text === null;
	statusText.textContent = text ?? '';
	statusBar.hidden = progress === null;
	if ( progress !== null ) statusBar.value = progress;

}

// Models

let backend = null;

const ready = ( async () => {

	setStatus( 'Loading models…', 0 );

	const downloads = {};

	const progress = name => ( loaded, total ) => {

		downloads[ name ] = [ loaded, total ];

		const values = Object.values( downloads );
		const sumLoaded = values.reduce( ( sum, [ l ] ) => sum + l, 0 );
		const sumTotal = values.reduce( ( sum, [ , t ] ) => sum + t, 0 );
		const mb = ( sumLoaded / 1048576 ).toFixed( 1 );

		setStatus( `Loading models… ${ mb } MB`, sumTotal ? sumLoaded / sumTotal : null );

	};

	const [ ep ] = await Promise.all( [
		loadOCR( progress( 'ocr' ) ),
		loadDictionary( progress( 'dictionary' ) ),
		loadReading()
	] );

	backend = ep;
	setStatus( null );

} )();

ready.catch( error => {

	console.error( error );
	setStatus( `Could not load the models: ${ error.message }` );
	failed = true;

} );

// Settings

function loadSetting( key, fallback ) {

	try { return localStorage.getItem( key ) ?? fallback; } catch { return fallback; }

}

function saveSetting( key, value ) {

	try { localStorage.setItem( key, value ); } catch { /* ignore */ }

}

for ( const name of [ 'romaji', 'english' ] ) {

	const toggle = $( `#${ name }-toggle` );
	toggle.checked = loadSetting( name, '1' ) === '1';
	document.body.classList.toggle( `hide-${ name }`, ! toggle.checked );

	toggle.addEventListener( 'change', () => {

		document.body.classList.toggle( `hide-${ name }`, ! toggle.checked );
		saveSetting( name, toggle.checked ? '1' : '0' );

	} );

}

// Input

for ( const input of document.querySelectorAll( 'input[type=file]' ) ) {

	input.addEventListener( 'change', () => {

		if ( input.files[ 0 ] ) process( input.files[ 0 ] );
		input.value = '';

	} );

}

document.addEventListener( 'paste', event => {

	const file = [ ...event.clipboardData.files ].find( f => f.type.startsWith( 'image/' ) );
	if ( file ) process( file );

} );

document.addEventListener( 'dragover', event => event.preventDefault() );
document.addEventListener( 'drop', event => {

	event.preventDefault();
	const file = [ ...event.dataTransfer.files ].find( f => f.type.startsWith( 'image/' ) );
	if ( file ) process( file );

} );

// Pipeline

let busy = false;

async function process( file ) {

	if ( busy ) return;
	busy = true;

	try {

		const bitmap = await createImageBitmap( file, { imageOrientation: 'from-image' } );
		const scale = Math.min( 1, MAX_IMAGE_SIDE / Math.max( bitmap.width, bitmap.height ) );

		photo.width = Math.round( bitmap.width * scale );
		photo.height = Math.round( bitmap.height * scale );
		photo.getContext( '2d' ).drawImage( bitmap, 0, 0, photo.width, photo.height );
		bitmap.close();

		intro.hidden = true;
		viewer.hidden = false;
		overlay.innerHTML = '';
		overlay.setAttribute( 'viewBox', `0 0 ${ photo.width } ${ photo.height }` );
		closeSheet();
		cards = [];

		if ( backend === null ) setStatus( 'Waiting for models…' );
		await ready;

		const start = performance.now();
		setStatus( 'Finding text…' );

		const lines = await recognize( photo, ( done, total ) => {

			setStatus( `Reading line ${ Math.min( done + 1, total ) } of ${ total }…`, total ? done / total : 0 );

		} );

		render( lines );

		const seconds = ( ( performance.now() - start ) / 1000 ).toFixed( 1 );
		setStatus( null );
		$( '#summary' ).textContent = lines.length > 0
			? `Tap a line to see how to read it · ${ lines.length } lines · ${ seconds }s · ${ backend }`
			: 'No Japanese text found. Try getting closer, or a sharper photo.';

	} catch ( error ) {

		console.error( error );
		setStatus( `Something went wrong: ${ error.message }` );

	} finally {

		busy = false;

	}

}

// Rendering

function escape( text ) {

	return text.replace( /[&<>"]/g, c => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } )[ c ] );

}

let cards = [];
let current = - 1;

function render( lines ) {

	overlay.innerHTML = lines.map( ( line, i ) => {

		const points = line.quad.map( p => p.join( ',' ) ).join( ' ' );
		return `<polygon class="box" data-index="${ i }" points="${ points }" />`;

	} ).join( '' );

	cards = lines.map( line => {

		const words = annotate( line.text );

		const ruby = words.map( word => word.parts.map( part => part.ruby
			? `<ruby>${ escape( part.text ) }<rt>${ escape( part.ruby ) }</rt></ruby>`
			: escape( part.text )
		).join( '' ) ).join( '' );

		const romaji = words
			.filter( word => /[a-z0-9]/i.test( word.romaji ) )
			.map( word => word.romaji )
			.join( ' ' );

		const meanings = words.filter( word => word.meanings ).map( word => `<li class="meaning">
			<span class="word" lang="ja">${ escape( word.surface ) }</span>
			<span class="senses">${ word.meanings.map( ( sense, n ) => `<span class="sense">${ word.meanings.length > 1 ? `<b>${ n + 1 }</b> ` : '' }${ escape( sense ) }</span>` ).join( '' ) }</span>
		</li>` ).join( '' );

		const speech = words.map( word => word.reading ?? toHiragana( word.surface ) ).join( '' );

		return `<div class="line">
			<p class="ja" lang="ja">${ ruby }</p>
			<button class="speak" data-speech="${ escape( speech ) }" aria-label="Listen">
				<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>
			</button>
		</div>
		<p class="romaji">${ escape( romaji ) }</p>
		${ meanings ? `<ul class="meanings">${ meanings }</ul>` : '' }`;

	} );

}

// Sheet

function select( index ) {

	if ( cards.length === 0 ) return;

	current = ( index + cards.length ) % cards.length;

	for ( const element of overlay.querySelectorAll( '.selected' ) ) element.classList.remove( 'selected' );
	const box = overlay.querySelector( `[data-index="${ current }"]` );
	box.classList.add( 'selected' );

	card.innerHTML = cards[ current ];
	card.scrollTop = 0;
	$( '#position' ).textContent = `${ current + 1 } / ${ cards.length }`;
	sheet.hidden = false;
	document.body.classList.add( 'sheet-open' );

	// Keep the selected line visible above the sheet.

	requestAnimationFrame( () => {

		const rect = box.getBoundingClientRect();
		const top = document.querySelector( 'header' ).getBoundingClientRect().bottom + 8;
		const bottom = sheet.getBoundingClientRect().top - 8;

		if ( rect.top < top ) window.scrollBy( { top: rect.top - top, behavior: 'smooth' } );
		else if ( rect.bottom > bottom ) window.scrollBy( { top: rect.bottom - bottom, behavior: 'smooth' } );

	} );

}

function closeSheet() {

	current = - 1;
	sheet.hidden = true;
	document.body.classList.remove( 'sheet-open' );
	for ( const element of overlay.querySelectorAll( '.selected' ) ) element.classList.remove( 'selected' );

}

new ResizeObserver( () => {

	document.body.style.setProperty( '--sheet-height', `${ sheet.offsetHeight }px` );

} ).observe( sheet );

// Taps select the box under the finger, or the nearest one if the finger is close enough.

overlay.addEventListener( 'click', event => {

	const hit = event.target.closest( '.box' );

	if ( hit ) {

		select( Number( hit.dataset.index ) );
		return;

	}

	let nearest = null;
	let nearestDistance = 24;

	for ( const box of overlay.querySelectorAll( '.box' ) ) {

		const rect = box.getBoundingClientRect();
		const dx = Math.max( rect.left - event.clientX, 0, event.clientX - rect.right );
		const dy = Math.max( rect.top - event.clientY, 0, event.clientY - rect.bottom );
		const distance = Math.hypot( dx, dy );

		if ( distance < nearestDistance ) {

			nearest = box;
			nearestDistance = distance;

		}

	}

	if ( nearest ) select( Number( nearest.dataset.index ) );
	else closeSheet();

} );

// Tapping anywhere outside the photo and the sheet closes it too.

document.addEventListener( 'click', event => {

	if ( current === - 1 ) return;
	if ( event.target.closest( '#sheet, #overlay, header, button, label' ) ) return;
	closeSheet();

} );

$( '#previous' ).addEventListener( 'click', () => select( current - 1 ) );
$( '#next' ).addEventListener( 'click', () => select( current + 1 ) );
$( '#close' ).addEventListener( 'click', closeSheet );

card.addEventListener( 'click', event => {

	const button = event.target.closest( '.speak' );
	if ( button ) speak( button.dataset.speech );

	const meaning = event.target.closest( '.meaning' );
	if ( meaning ) meaning.classList.toggle( 'expanded' );

} );

// Swipe the sheet sideways to move between lines.

let touchStart = null;

sheet.addEventListener( 'touchstart', event => {

	touchStart = [ event.touches[ 0 ].clientX, event.touches[ 0 ].clientY ];

}, { passive: true } );

sheet.addEventListener( 'touchend', event => {

	if ( touchStart === null ) return;

	const dx = event.changedTouches[ 0 ].clientX - touchStart[ 0 ];
	const dy = event.changedTouches[ 0 ].clientY - touchStart[ 1 ];
	touchStart = null;

	if ( Math.abs( dx ) > 60 && Math.abs( dx ) > Math.abs( dy ) * 1.5 ) select( current + ( dx < 0 ? 1 : - 1 ) );

}, { passive: true } );

document.addEventListener( 'keydown', event => {

	if ( viewer.hidden || cards.length === 0 ) return;
	if ( event.key === 'ArrowRight' ) select( current + 1 );
	else if ( event.key === 'ArrowLeft' ) select( current - 1 );
	else if ( event.key === 'Escape' ) closeSheet();
	else return;
	event.preventDefault();

} );

function speak( text ) {

	if ( ! ( 'speechSynthesis' in self ) ) return;

	speechSynthesis.cancel();
	const utterance = new SpeechSynthesisUtterance( text );
	utterance.lang = 'ja-JP';
	utterance.rate = 0.85;
	const voice = speechSynthesis.getVoices().find( v => v.lang.replace( '_', '-' ).startsWith( 'ja' ) );
	if ( voice ) utterance.voice = voice;
	speechSynthesis.speak( utterance );

}

$( '#again' ).addEventListener( 'click', () => {

	closeSheet();
	viewer.hidden = true;
	intro.hidden = false;
	window.scrollTo( 0, 0 );

} );
