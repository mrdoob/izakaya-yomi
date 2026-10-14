// Pinch / double-tap / wheel zoom and drag panning for the photo.
// The stage (canvas + overlay) is fitted inside the frame, then transformed.

const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;
const TAP_SLOP = 8;

export class PhotoZoom {

	constructor( frame, stage ) {

		this.frame = frame;
		this.stage = stage;
		this.width = 1;
		this.height = 1;
		this.base = 1;
		this.scale = 1;
		this.x = 0;
		this.y = 0;

		// Part of the frame covered from the bottom (by the sheet), in pixels.
		this.coveredBottom = 0;

		this.pointers = new Map();
		this.moved = 0;
		this.suppressClickUntil = 0;
		this.lastTap = null;

		frame.addEventListener( 'pointerdown', event => this.onPointerDown( event ) );
		window.addEventListener( 'pointermove', event => this.onPointerMove( event ) );
		window.addEventListener( 'pointerup', event => this.onPointerUp( event ) );
		window.addEventListener( 'pointercancel', event => this.onPointerUp( event ) );
		frame.addEventListener( 'wheel', event => this.onWheel( event ), { passive: false } );

		// Don't let a click that ended a drag or pinch select a line.
		frame.addEventListener( 'click', event => {

			if ( performance.now() < this.suppressClickUntil ) event.stopPropagation();

		}, true );

		new ResizeObserver( () => this.layout() ).observe( frame );

	}

	setImage( width, height ) {

		this.width = width;
		this.height = height;
		this.scale = 1;
		this.layout();

	}

	layout() {

		const { clientWidth, clientHeight } = this.frame;
		if ( clientWidth === 0 || clientHeight === 0 ) return;

		const previous = this.base;
		this.base = Math.min( clientWidth / this.width, clientHeight / this.height );
		this.stage.style.width = `${ this.width * this.base }px`;
		this.stage.style.height = `${ this.height * this.base }px`;

		// Keep the same part of the image in view when the frame resizes.
		const k = this.base / previous;
		this.x *= k;
		this.y *= k;

		this.clamp();
		this.apply();

	}

	setCoveredBottom( pixels ) {

		this.coveredBottom = pixels;
		this.clamp();
		this.apply( true );

	}

	view() {

		return {
			width: this.frame.clientWidth,
			height: Math.max( 1, this.frame.clientHeight - this.coveredBottom )
		};

	}

	clamp() {

		const view = this.view();
		const axis = ( offset, content, size ) => content <= size ? ( size - content ) / 2 : Math.min( 0, Math.max( size - content, offset ) );

		this.x = axis( this.x, this.width * this.base * this.scale, view.width );
		this.y = axis( this.y, this.height * this.base * this.scale, view.height );

	}

	apply( animate = false ) {

		this.stage.style.transition = animate ? 'transform 0.25s ease' : '';
		this.stage.style.transform = `translate(${ this.x }px, ${ this.y }px) scale(${ this.scale })`;

	}

	// Zooms keeping the frame point (fx, fy) fixed.

	zoomAt( fx, fy, scale, animate = false ) {

		scale = Math.min( MAX_SCALE, Math.max( 1, scale ) );
		const k = scale / this.scale;
		this.x = fx - ( fx - this.x ) * k;
		this.y = fy - ( fy - this.y ) * k;
		this.scale = scale;
		this.clamp();
		this.apply( animate );

	}

	// Pans so a rectangle (in image pixels) is visible, if it isn't already.

	reveal( left, top, right, bottom ) {

		const view = this.view();
		const f = this.base * this.scale;
		const margin = 16;

		const shift = ( start, end, size ) => {

			if ( end - start > size - 2 * margin ) return ( size - ( start + end ) ) / 2;
			if ( start < margin ) return margin - start;
			if ( end > size - margin ) return size - margin - end;
			return 0;

		};

		this.x += shift( left * f + this.x, right * f + this.x, view.width );
		this.y += shift( top * f + this.y, bottom * f + this.y, view.height );
		this.clamp();
		this.apply( true );

	}

	framePoint( event ) {

		const rect = this.frame.getBoundingClientRect();
		return [ event.clientX - rect.left, event.clientY - rect.top ];

	}

	onPointerDown( event ) {

		if ( event.pointerType === 'mouse' && event.button !== 0 ) return;

		this.pointers.set( event.pointerId, this.framePoint( event ) );
		if ( this.pointers.size === 1 ) this.moved = 0;
		this.stage.style.transition = '';

	}

	onPointerMove( event ) {

		const previous = this.pointers.get( event.pointerId );
		if ( previous === undefined ) return;

		const points = [ ...this.pointers.values() ];
		const current = this.framePoint( event );
		this.pointers.set( event.pointerId, current );

		if ( this.pointers.size === 1 ) {

			const dx = current[ 0 ] - previous[ 0 ];
			const dy = current[ 1 ] - previous[ 1 ];
			this.moved += Math.hypot( dx, dy );
			this.x += dx;
			this.y += dy;
			this.clamp();
			this.apply();

		} else if ( this.pointers.size === 2 ) {

			const after = [ ...this.pointers.values() ];
			const mid = p => [ ( p[ 0 ][ 0 ] + p[ 1 ][ 0 ] ) / 2, ( p[ 0 ][ 1 ] + p[ 1 ][ 1 ] ) / 2 ];
			const distance = p => Math.hypot( p[ 0 ][ 0 ] - p[ 1 ][ 0 ], p[ 0 ][ 1 ] - p[ 1 ][ 1 ] );

			const [ mx0, my0 ] = mid( points );
			const [ mx1, my1 ] = mid( after );
			const d0 = distance( points );

			this.moved += TAP_SLOP + 1;
			this.x += mx1 - mx0;
			this.y += my1 - my0;
			this.zoomAt( mx1, my1, d0 > 0 ? this.scale * distance( after ) / d0 : this.scale );

		}

	}

	onPointerUp( event ) {

		if ( ! this.pointers.has( event.pointerId ) ) return;

		const point = this.pointers.get( event.pointerId );
		this.pointers.delete( event.pointerId );

		if ( this.moved > TAP_SLOP ) {

			this.suppressClickUntil = performance.now() + 300;
			this.lastTap = null;
			return;

		}

		if ( this.pointers.size > 0 || event.type === 'pointercancel' ) return;

		// Double tap toggles between fitted and zoomed in.

		const now = performance.now();
		const last = this.lastTap;

		if ( last && now - last.time < 300 && Math.hypot( point[ 0 ] - last.point[ 0 ], point[ 1 ] - last.point[ 1 ] ) < 30 ) {

			this.lastTap = null;

			if ( this.scale > 1.05 ) this.zoomAt( point[ 0 ], point[ 1 ], 1, true );
			else this.zoomAt( point[ 0 ], point[ 1 ], DOUBLE_TAP_SCALE, true );

		} else {

			this.lastTap = { time: now, point };

		}

	}

	onWheel( event ) {

		event.preventDefault();

		const [ fx, fy ] = this.framePoint( event );

		if ( event.ctrlKey ) {

			// Trackpad pinch (and ctrl + wheel).
			this.zoomAt( fx, fy, this.scale * Math.exp( - event.deltaY * 0.01 ) );

		} else {

			this.x -= event.deltaX;
			this.y -= event.deltaY;
			this.clamp();
			this.apply();

		}

	}

}
