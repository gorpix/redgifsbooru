// Built-in guesses of which genders common RedGifs tags imply, from general knowledge of the site's
// tags (no API calls). Only tags that are clearly about one body type or role are listed; ambiguous
// ones (anal, hardcore, sex, threesome ...) are left out. `solo` alone implies nothing, but `solo
// female` / `solo male` do. Users override any entry in settings (store/implications.ts).
import type { Gender } from './implications';
import { normalizeTag } from './tags';

const F: readonly Gender[] = ['female'];
const M: readonly Gender[] = ['male'];
const T: readonly Gender[] = ['trans'];
const FM: readonly Gender[] = ['female', 'male'];

const FEMALE = [
  'pussy', 'tight pussy', 'wet pussy', 'pink pussy', 'puffy pussy', 'shaved pussy', 'hairy pussy', 'pierced pussy',
  'pussy lips', 'camel toe', 'cameltoe', 'clit', 'clitoris', 'labia', 'vagina', 'vulva',
  'tits', 'boobs', 'big tits', 'big boobs', 'huge tits', 'huge boobs', 'small tits', 'small boobs', 'natural tits',
  'natural boobs', 'fake tits', 'fake boobs', 'perky tits', 'saggy tits', 'tiny tits', 'busty', 'bra', 'braless',
  'cleavage', 'underboob', 'sideboob', 'areolas', 'big areolas', 'tits out', 'tit drop', 'boob drop', 'boob bounce',
  'nipple slip', 'topless',
  'squirt', 'squirting', 'squirting orgasm', 'female orgasm', 'pussy rubbing', 'pussy spread', 'spread pussy',
  'pussy eating', 'pussy licking', 'cunnilingus', 'fingering', 'finger fuck',
  'milf', 'milfs', 'gilf', 'teen', 'teens', 'cougar', 'girl', 'girls', 'girlfriend', 'wife', 'hotwife', 'babe',
  'hot girl', 'camgirl', 'cam girl', 'schoolgirl', 'cheerleader', 'barely legal', 'amateur girl',
  'bbw', 'ssbbw', 'pawg', 'pregnant', 'lactating', 'panties', 'lingerie', 'bikini', 'solo female', 'solo girl',
  'lesbian', 'lesbians', 'lesbian sex', 'scissoring', 'tribbing', 'girl on girl', 'girls kissing', 'lesbian kissing',
  'anime girl', 'cosplay girl', 'nude girl',
];

const MALE = [
  'dick', 'cock', 'big dick', 'big cock', 'huge dick', 'huge cock', 'small dick', 'small cock', 'penis', 'bbc', 'bwc',
  'uncut', 'uncut cock', 'circumcised', 'balls', 'ball licking', 'ball sucking', 'erection', 'boner', 'hung',
  'precum', 'pre cum', 'jerking off', 'jerk off', 'dick stroking', 'cock stroking',
  'cumshot', 'cumshots', 'cum shot', 'facial', 'facials', 'handjob', 'hand job', 'blowjob', 'blowjobs', 'blow job',
  'deepthroat', 'face fuck', 'facefuck', 'throatpie', 'cock sucking', 'cocksucking', 'sucking dick', 'bukkake',
  'cum in mouth', 'cum swallow', 'swallowing', 'cum on face',
  'gay', 'gay sex', 'twink', 'twinks', 'jock', 'hunk', 'muscle men',
  'femboy', 'femboys', 'sissy', 'sissies', 'solo male', 'solo guy', 'guy', 'guys', 'man', 'men', 'boy',
];

const TRANS = [
  'trans', 'transgender', 'shemale', 'shemales', 'tgirl', 'tgirls', 't girl', 'trans girl', 'trans woman',
  'trans women', 'trans man', 'trans female', 'transsexual', 'ladyboy', 'ladyboys', 'futanari', 'futa',
  'mtf', 'ftm', 'trans solo', 'trans cock', 'trans sex', 'trans cumshot',
];

const FEMALE_MALE = [
  'straight', 'couple', 'couples', 'missionary', 'cowgirl', 'reverse cowgirl', 'doggystyle', 'doggy style',
  'creampie', 'creampies', 'cum in pussy', 'cum on tits', 'cum on pussy', 'cum on belly',
  'titjob', 'titty fuck', 'tit fuck', 'titfuck', 'paizuri', 'pussy fucking', 'fucking pussy', 'riding cock',
  'riding dick', 'sucking cock', 'cock riding', 'dick riding', 'bisexual', 'bi', 'bi sex', 'mff', 'ffm', 'mmf', 'mfm',
  'boyfriend and girlfriend', 'husband and wife', 'pov blowjob', 'pov sex',
];

function build(): Readonly<Record<string, readonly Gender[]>> {
  const out: Record<string, readonly Gender[]> = {};
  const add = (tags: string[], genders: readonly Gender[]) => {
    for (const tag of tags) out[normalizeTag(tag)] = genders;
  };
  add(FEMALE, F);
  add(MALE, M);
  add(TRANS, T);
  add(FEMALE_MALE, FM);
  return out;
}

export const BUILTIN_IMPLICATIONS: Readonly<Record<string, readonly Gender[]>> = build();
