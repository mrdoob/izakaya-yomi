// Service worker registration, offline status and the install button.

const $ = selector => document.querySelector( selector );

const offlineStatus = $( '#offline-status' );
const installLink = $( '#install' );
const installHint = $( '#install-hint' );

function sessionStorageGet( key ) {

	try { return sessionStorage.getItem( key ); } catch { return null; }

}

function sessionStorageSet( key, value ) {

	try { sessionStorage.setItem( key, value ); } catch { /* ignore */ }

}

// Offline status

let offlineReady = false;

function showOffline( text, state ) {

	offlineStatus.textContent = text;
	offlineStatus.dataset.state = state;
	offlineStatus.hidden = false;

}

function onCacheProgress( done, total ) {

	if ( done >= total ) {

		offlineReady = true;
		showOffline( 'Ready offline', 'ready' );

	} else if ( ! offlineReady ) {

		showOffline( `Saving for offline… ${ Math.round( done / total * 100 ) }%`, 'saving' );

	}

}

if ( 'serviceWorker' in navigator ) {

	navigator.serviceWorker.addEventListener( 'message', event => {

		const { type, done, total } = event.data ?? {};
		if ( type === 'cache-progress' ) onCacheProgress( done, total );

	} );

	navigator.serviceWorker.register( './sw.js' ).then( registration => {

		// The service worker adds the headers for cross-origin isolation (multithreaded WASM),
		// which only apply after a reload.
		if ( ! self.crossOriginIsolated && registration.active && ! sessionStorageGet( 'coi-reloaded' ) ) {

			sessionStorageSet( 'coi-reloaded', '1' );
			location.reload();
			return;

		}

		if ( ! registration.active ) showOffline( 'Saving for offline…', 'saving' );

		navigator.serviceWorker.ready.then( ready => ready.active.postMessage( { type: 'cache-status' } ) );

	} ).catch( error => {

		console.warn( 'Service worker not available, offline mode is disabled.', error );
		showOffline( 'Offline mode isn\'t available here', 'unavailable' );

	} );

	navigator.serviceWorker.addEventListener( 'controllerchange', () => {

		if ( ! self.crossOriginIsolated && ! sessionStorageGet( 'coi-reloaded' ) ) {

			sessionStorageSet( 'coi-reloaded', '1' );
			location.reload();

		}

	} );

} else {

	showOffline( 'Offline mode isn\'t available in this browser', 'unavailable' );

}

// Install

const standalone = matchMedia( '(display-mode: standalone)' ).matches || navigator.standalone === true;
const ios = /iPhone|iPad|iPod/.test( navigator.userAgent ) || ( navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 );

let installPrompt = null;

function showInstalled() {

	installLink.hidden = true;
	installHint.hidden = true;

}

if ( standalone ) {

	showInstalled();

} else if ( ios ) {

	installHint.hidden = false;

}

// Chrome only fires this when the app can be installed (so it isn't installed yet).
// Cancelling it stops Chrome's own install banner; the link below is used instead.
window.addEventListener( 'beforeinstallprompt', event => {

	event.preventDefault();
	installPrompt = event;
	installLink.hidden = false;

} );

installLink.addEventListener( 'click', async event => {

	event.preventDefault();
	if ( installPrompt === null ) return;

	installPrompt.prompt();
	const { outcome } = await installPrompt.userChoice;
	installPrompt = null;
	if ( outcome === 'accepted' ) showInstalled();
	else installLink.hidden = true;

} );

window.addEventListener( 'appinstalled', showInstalled );
