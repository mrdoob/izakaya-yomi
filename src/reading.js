// Word segmentation and readings with kuromoji.js (IPADIC), plus furigana alignment and romaji.

import { GLOSSARY, MENU_ENGLISH } from './glossary.js';
import * as dictionary from './dictionary.js';

let tokenizer = null;

export function loadReading() {

	return new Promise( ( resolve, reject ) => {

		// kuromoji joins paths with path.join(), which mangles absolute URLs, so this is relative to the page.
		const dicPath = 'vendor/kuromoji/dict/';

		kuromoji.builder( { dicPath } ).build( ( error, result ) => {

			if ( error ) return reject( error );
			tokenizer = result;
			resolve();

		} );

	} );

}

const KANJI = /[㐀-䶿一-鿿豈-﫿々〆ヶ]/;
const KANJI_RUN = /[㐀-䶿一-鿿豈-﫿々〆ヶ]+|[^㐀-䶿一-鿿豈-﫿々〆ヶ]+/g;

export function hasKanji( text ) {

	return KANJI.test( text );

}

export function toHiragana( text ) {

	return text.replace( /[ァ-ヶ]/g, c => String.fromCharCode( c.charCodeAt( 0 ) - 0x60 ) );

}

// Splits a word into parts so the reading only sits on top of the kanji.
// 焼き鳥 + やきとり → [焼/や][き][鳥/とり]

function alignFurigana( surface, reading ) {

	const parts = surface.match( KANJI_RUN );
	let pattern = '^';

	for ( const part of parts ) {

		pattern += hasKanji( part ) ? '(.+?)' : `(${ toHiragana( part ).replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) })`;

	}

	const match = toHiragana( reading ).match( new RegExp( pattern + '$' ) );
	if ( match === null ) return [ { text: surface, ruby: reading } ];

	return parts.map( ( part, i ) => hasKanji( part ) ? { text: part, ruby: match[ i + 1 ] } : { text: part } );

}

// Returns one entry per word: { surface, reading (hiragana or null), parts, romaji, meanings }.
// Menu words and numbers are matched first, kuromoji takes care of the rest,
// then words that form a compound in JMdict are joined (一夜 + 干し → 一夜干し).

export function annotate( text ) {

	const words = [];
	let rest = '';

	const flush = () => {

		if ( rest !== '' ) words.push( ...tokenize( rest ) );
		rest = '';

	};

	for ( let i = 0; i < text.length; ) {

		const number = matchNumber( text, i );

		if ( number ) {

			flush();
			words.push( word( number.surface, number.reading, '数' ) );
			i += number.surface.length;
			continue;

		}

		const surface = matchGlossary( text, i );

		if ( surface ) {

			flush();
			words.push( word( surface, GLOSSARY[ surface ] ) );
			i += surface.length;
			continue;

		}

		const char = String.fromCodePoint( text.codePointAt( i ) );
		rest += char;
		i += char.length;

	}

	flush();

	return joinCompounds( words ).map( w => ( { ...w, meanings: meaningsFor( w ) } ) );

}

const NOT_JOINABLE = new Set( [ '数', '記号' ] );

function joinCompounds( words ) {

	const result = [];

	for ( let i = 0; i < words.length; ) {

		let joined = null;

		for ( let length = Math.min( 6, words.length - i ); length >= 2 && joined === null; length -- ) {

			const range = words.slice( i, i + length );
			if ( range.some( w => NOT_JOINABLE.has( w.pos ) ) ) continue;

			const surface = range.map( w => w.surface ).join( '' );
			if ( ! hasKanji( surface ) && surface.length < 3 ) continue;
			if ( ! dictionary.has( surface ) ) continue;

			const reading = range.map( w => w.reading ?? toHiragana( w.surface ) ).join( '' );
			const entry = dictionary.lookup( surface, reading );
			joined = { word: word( surface, entry.reading ), length };

		}

		if ( joined ) {

			result.push( joined.word );
			i += joined.length;

		} else {

			result.push( words[ i ] );
			i ++;

		}

	}

	return result;

}

const NO_MEANING = new Set( [ '数', '記号', '助詞', '助動詞', '接頭詞', 'フィラー' ] );

function meaningsFor( w ) {

	if ( NO_MEANING.has( w.pos ) || w.surface === '円' ) return null;
	if ( MENU_ENGLISH[ w.surface ] ) return [ MENU_ENGLISH[ w.surface ] ];
	if ( /^[ぁ-ゖ]$/.test( w.surface ) ) return null;

	const entry = dictionary.lookup( w.surface, w.reading ) ?? ( w.base ? dictionary.lookup( w.base ) : null );
	return entry ? entry.senses : null;

}

const GLOSSARY_MAX_LENGTH = Math.max( ...Object.keys( GLOSSARY ).map( key => key.length ) );

function matchGlossary( text, index ) {

	for ( let length = GLOSSARY_MAX_LENGTH; length > 0; length -- ) {

		const candidate = text.slice( index, index + length );
		if ( candidate.length === length && Object.hasOwn( GLOSSARY, candidate ) ) return candidate;

	}

	return null;

}

function tokenize( text ) {

	return tokenizer.tokenize( text ).map( token => {

		const known = token.reading !== undefined && token.reading !== '*';
		const base = token.basic_form !== '*' && token.basic_form !== token.surface_form ? token.basic_form : null;
		return word( token.surface_form, known ? toHiragana( token.reading ) : null, token.pos, base );

	} );

}

function word( surface, reading, pos = '名詞', base = null ) {

	let parts = [ { text: surface } ];

	// Arabic numerals get no furigana (it's long and only the romaji is needed).
	if ( hasKanji( surface ) ) {

		parts = reading ? alignFurigana( surface, reading ) : [ { text: surface, ruby: '?' } ];

	}

	const kana = reading ?? toHiragana( surface );
	const romaji = pos === '助詞' ? particleRomaji( kana ) : toRomaji( kana );

	return { surface, reading, parts, romaji, pos, base };

}

// Numbers, mostly prices: 880円, 1,200円, 八八〇円, 八百八十円.

const DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function matchNumber( text, index ) {

	const arabic = text.slice( index ).match( /^[0-9０-９]+(?:[,，][0-9０-９]{3})*/ );

	if ( arabic ) {

		const value = Number( arabic[ 0 ].replace( /[,，]/g, '' ).replace( /[０-９]/g, c => c.charCodeAt( 0 ) - 0xFF10 ) );
		return { surface: arabic[ 0 ], reading: numberReading( value, text[ index + arabic[ 0 ].length ] ) };

	}

	// Kanji numerals are only read as numbers right before 円, so 一夜干し stays a word.

	const kanji = text.slice( index ).match( /^[〇零一二三四五六七八九十百千万]+(?=円)/ );
	if ( kanji === null ) return null;

	let value = 0;

	if ( /[十百千万]/.test( kanji[ 0 ] ) ) {

		let section = 0;
		let digit = null;

		for ( const char of kanji[ 0 ] ) {

			if ( char in DIGITS ) {

				digit = DIGITS[ char ];

			} else if ( char === '万' ) {

				value += ( section + ( digit ?? 0 ) || 1 ) * 10000;
				section = 0;
				digit = null;

			} else {

				section += ( digit ?? 1 ) * UNITS[ char ];
				digit = null;

			}

		}

		value += section + ( digit ?? 0 );

	} else {

		value = Number( [ ...kanji[ 0 ] ].map( char => DIGITS[ char ] ).join( '' ) );

	}

	return { surface: kanji[ 0 ], reading: numberReading( value, '円' ) };

}

const ONES = [ '', 'いち', 'に', 'さん', 'よん', 'ご', 'ろく', 'なな', 'はち', 'きゅう' ];
const HUNDREDS = [ '', 'ひゃく', 'にひゃく', 'さんびゃく', 'よんひゃく', 'ごひゃく', 'ろっぴゃく', 'ななひゃく', 'はっぴゃく', 'きゅうひゃく' ];
const THOUSANDS = [ '', 'せん', 'にせん', 'さんぜん', 'よんせん', 'ごせん', 'ろくせん', 'ななせん', 'はっせん', 'きゅうせん' ];

function belowTenThousand( n ) {

	const thousands = Math.floor( n / 1000 );
	const hundreds = Math.floor( n / 100 ) % 10;
	const tens = Math.floor( n / 10 ) % 10;
	const ones = n % 10;

	return THOUSANDS[ thousands ] + HUNDREDS[ hundreds ] +
		( tens > 1 ? ONES[ tens ] : '' ) + ( tens > 0 ? 'じゅう' : '' ) + ONES[ ones ];

}

function numberReading( n, next ) {

	if ( n === 0 ) return 'ぜろ';
	if ( n >= 1e8 ) return null;

	const man = Math.floor( n / 10000 );
	let reading = ( man > 0 ? belowTenThousand( man ) + 'まん' : '' ) + belowTenThousand( n % 10000 );

	// 4円 is よえん, not よんえん.
	if ( next === '円' && n % 10 === 4 ) reading = reading.replace( /よん$/, 'よ' );

	return reading;

}

// Romaji (Hepburn)

const DIGRAPHS = {
	きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she',
	ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
	ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
	りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
	じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je', ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
	びゃ: 'bya', びゅ: 'byu', びょ: 'byo', ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
	ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
	うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo', つぁ: 'tsa'
};

const MONOGRAPHS = {
	あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o', か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
	さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so', た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
	な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no', は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
	ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo', や: 'ya', ゆ: 'yu', よ: 'yo',
	ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro', わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
	が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go', ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
	だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do', ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
	ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po', ゔ: 'vu',
	ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa'
};

export function toRomaji( text ) {

	const kana = toHiragana( text );
	let result = '';
	let geminate = false;

	for ( let i = 0; i < kana.length; i ++ ) {

		const pair = kana.slice( i, i + 2 );
		let syllable = DIGRAPHS[ pair ];

		if ( syllable ) {

			i ++;

		} else if ( kana[ i ] === 'っ' ) {

			geminate = true;
			continue;

		} else if ( kana[ i ] === 'ー' ) {

			const vowel = result.match( /[aiueo]$/ );
			syllable = vowel ? vowel[ 0 ] : '';

		} else if ( kana[ i ] === 'ん' && /^[aiueoy]/.test( MONOGRAPHS[ kana[ i + 1 ] ] ?? '' ) ) {

			syllable = "n'";

		} else {

			syllable = MONOGRAPHS[ kana[ i ] ] ?? kana[ i ];

		}

		if ( geminate ) {

			result += syllable.startsWith( 'ch' ) ? 't' : /^[a-z]/.test( syllable ) && ! /^[aiueon]/.test( syllable ) ? syllable[ 0 ] : '';
			geminate = false;

		}

		result += syllable;

	}

	return result;

}

function particleRomaji( kana ) {

	if ( kana === 'は' ) return 'wa';
	if ( kana === 'へ' ) return 'e';
	if ( kana === 'を' ) return 'o';
	return toRomaji( kana );

}
