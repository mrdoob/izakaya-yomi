// Converts jmdict-simplified (https://github.com/scriptin/jmdict-simplified) into the
// compact gzipped file the app loads.
//
// Usage: node scripts/build-jmdict.mjs path/to/jmdict-eng-x.y.z.json
//
// Output: data/jmdict-eng.txt.gz, one entry per line:
//   kanji forms \t kana forms \t common \t senses
// Lists are separated by \x1f, senses by \x1e, glosses within a sense by "; ".
// A kana form restricted to some kanji forms is written as kana[kanji1|kanji2].

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const MAX_SENSES = 3;
const MAX_GLOSSES = 4;

const input = process.argv[ 2 ];

if ( ! input ) {

	console.error( 'Usage: node scripts/build-jmdict.mjs path/to/jmdict-eng.json' );
	process.exit( 1 );

}

const jmdict = JSON.parse( fs.readFileSync( input, 'utf8' ) );
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
const output = path.join( path.dirname( new URL( import.meta.url ).pathname ), '../data/jmdict-eng.txt.gz' );

fs.writeFileSync( output, zlib.gzipSync( header + text, { level: 9 } ) );

console.log( `${ lines.length } entries, ${ ( Buffer.byteLength( text ) / 1048576 ).toFixed( 1 ) } MB → ${ ( fs.statSync( output ).size / 1048576 ).toFixed( 1 ) } MB gzipped` );
