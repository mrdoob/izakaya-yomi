// Converts jmdict-simplified (https://github.com/scriptin/jmdict-simplified) into the
// compact gzipped file the app loads.
//
// Usage:
//   node scripts/build-jmdict.mjs                     downloads the release named in dict/release.txt
//   node scripts/build-jmdict.mjs jmdict-eng-x.json   uses a local file
//
// Output: dict/jmdict-eng.txt.gz, one entry per line:
//   kanji forms \t kana forms \t common \t senses
// Lists are separated by \x1f, senses by \x1e, glosses within a sense by "; ".
// A kana form restricted to some kanji forms is written as kana[kanji1|kanji2].

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_SENSES = 3;
const MAX_GLOSSES = 4;

const root = path.join( path.dirname( new URL( import.meta.url ).pathname ), '..' );

// Returns the contents of the first .json file in a .tgz.

function extractJson( tgz ) {

	const tar = zlib.gunzipSync( tgz );

	for ( let offset = 0; offset + 512 <= tar.length; ) {

		const name = tar.toString( 'utf8', offset, offset + 100 ).replace( /\0.*$/s, '' );
		const size = parseInt( tar.toString( 'utf8', offset + 124, offset + 136 ).replace( /\0.*$/s, '' ).trim(), 8 ) || 0;
		if ( name === '' ) break;
		if ( name.endsWith( '.json' ) ) return tar.toString( 'utf8', offset + 512, offset + 512 + size );
		offset += 512 + Math.ceil( size / 512 ) * 512;

	}

	throw new Error( 'No .json file found in the archive' );

}

async function download() {

	const release = fs.readFileSync( path.join( root, 'dict/release.txt' ), 'utf8' ).trim();
	const name = `jmdict-eng-${ release }.json.tgz`;
	const url = `https://github.com/scriptin/jmdict-simplified/releases/download/${ encodeURIComponent( release ) }/${ encodeURIComponent( name ) }`;

	console.log( `Downloading ${ name }` );
	const response = await fetch( url );
	if ( ! response.ok ) throw new Error( `Failed to download ${ url }: ${ response.status }` );

	return extractJson( Buffer.from( await response.arrayBuffer() ) );

}

const input = process.argv[ 2 ];
const json = input ? fs.readFileSync( input, 'utf8' ) : await download();

const jmdict = JSON.parse( json );
const lines = [];

for ( const word of jmdict.words ) {

	const kanji = word.kanji.map( k => k.text );

	const kana = word.kana.map( k => {

		const appliesTo = k.appliesToKanji;
		if ( kanji.length === 0 || appliesTo.includes( '*' ) ) return k.text;
		return `${ k.text }[${ appliesTo.join( '|' ) }]`;

	} );

	const common = word.kanji.some( k => k.common ) || word.kana.some( k => k.common );

	const senses = word.sense
		.slice( 0, MAX_SENSES )
		.map( sense => sense.gloss.slice( 0, MAX_GLOSSES ).map( g => g.text ).join( '; ' ) );

	lines.push( [ kanji.join( '\x1f' ), kana.join( '\x1f' ), common ? '1' : '', senses.join( '\x1e' ) ].join( '\t' ) );

}

const text = lines.join( '\n' ) + '\n';
const header = `# JMdict ${ jmdict.dictDate } (jmdict-simplified ${ jmdict.version }), CC BY-SA 4.0, EDRDG\n`;
const output = path.join( root, 'dict/jmdict-eng.txt.gz' );

fs.writeFileSync( output, zlib.gzipSync( header + text, { level: 9 } ) );

console.log( `${ lines.length } entries, ${ ( Buffer.byteLength( text ) / 1048576 ).toFixed( 1 ) } MB → ${ ( fs.statSync( output ).size / 1048576 ).toFixed( 1 ) } MB gzipped` );
