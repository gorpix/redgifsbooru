// Built-in guesses of which category common RedGifs tags belong to, compiled from general
// knowledge of the site's tags (no API calls). Tags not listed are 'general'; users can override
// any of them in settings (store/categories.ts). Keys are normalized tag keys.
import type { Category } from './categories';
import { normalizeTag } from './tags';

/** Physical traits, looks, clothing and body parts. */
const BODY = [
  'big tits', 'small tits', 'huge tits', 'natural tits', 'fake tits', 'perky tits', 'saggy tits', 'tits', 'boobs',
  'big ass', 'small ass', 'huge ass', 'phat ass', 'round ass', 'ass', 'booty', 'pawg', 'bubble butt', 'thick',
  'curvy', 'chubby', 'bbw', 'ssbbw', 'skinny', 'slim', 'petite', 'tiny', 'athletic', 'muscular',
  'slender', 'busty', 'voluptuous', 'thicc', 'hourglass',
  'redhead', 'blonde', 'brunette', 'black hair', 'pink hair', 'blue hair', 'purple hair', 'ginger', 'long hair',
  'pigtails', 'ponytail', 'bald', 'hairy pussy', 'shaved pussy', 'hairy', 
  'tattoo', 'tattooed', 'piercing', 'nipple piercing', 'belly piercing', 'pierced pussy', 'freckles',
  'tan lines', 'pale', 'tanned', 'curly hair',
  'asian', 'latina', 'ebony', 'indian', 'arab', 'japanese', 'korean', 'chinese', 'thai',
  'brazilian', 'colombian', 'russian', 'german', 'european', 'african', 'filipina', 'persian', 'desi',
  'teen', 'milf', 'gilf', 'granny', 'cougar', 'barely legal', 
  'pussy', 'tight pussy', 'wet pussy', 'pink pussy', 'puffy pussy', 'puffy nipples', 'nipples', 'areolas',
  'camel toe', 'pussy lips', 'clit', 'asshole', 'cock', 'big dick', 'small dick', 'big cock', 'dick', 'balls',
  'feet', 'foot', 'toes', 'soles', 'legs', 'thighs', 'thick thighs', 'stomach', 'abs', 'belly', 'hips',
  'pregnant', 'lactating', 'trans', 'transgender', 'shemale', 'femboy', 'futanari', 
  'cosplay girl', 'pornstar', 
  'lingerie', 'panties', 'thong', 'bikini', 'stockings', 'pantyhose', 'tights', 'fishnets', 'garter',
  'high heels', 'heels', 'thigh highs', 'leggings', 'yoga pants', 
  'mini skirt', 'bodysuit', 'corset', 'latex', 'leather', 'catsuit', 'crop top', 'tank top',
  't shirt', 'swimsuit', 'one piece', 'micro bikini', 'sheer', 'see through', 'braless',
  'topless', 'bottomless', 'naked', 'nude', 'nudes', 'schoolgirl', 'uniform', 'nurse', 'maid', 'cheerleader',
  'secretary', 'teacher', 'police', 'stewardess', 
  'stockings and heels', 'ass crack', 'underboob', 'sideboob', 'cleavage', 'bouncing tits',
] as const;

/** Sex acts, kinks and what people are doing. */
const ACT = [
  'blowjob', 'deepthroat', 'handjob', 'footjob', 'titfuck', 'titty fuck', 'tit fuck', 'tit slapping', 'face fuck',
  'throat fuck', 'oral', 'sloppy blowjob', 'cock sucking', 'rimming', 'rimjob', 'pussy licking',
  'pussy eating', 'cunnilingus', '69', 'face sitting', 'facesitting', 'eating pussy', 
  'anal', 'anal sex', 'anal creampie', 'anal beads', 'double anal', 'anal gape', 'gape', 'gaping', 'fisting',
  'double penetration', 'dp', 'triple penetration', 'creampie', 'cum in pussy', 'cum in mouth', 'cum on tits',
  'cum on ass', 'cum on face', 'cum swallow', 'swallowing', 'cumshot', 'cumshots', 'facial', 'bukkake', 'cum',
  'cum play', 'cum eating', 'cum inside', 'creampie eating', 'cumslut', 'pull out', 'squirting', 'squirt',
  'orgasm', 'orgasms', 'multiple orgasms', 'female orgasm', 'moaning', 'screaming', 'dirty talk', 'cum countdown',
  'masturbating', 'masturbation', 'fingering', 'solo', 'dildo', 'vibrator', 'sex toy', 'buttplug', 'butt plug',
  'anal toy', 'magic wand', 'hitachi', 'strap on', 'pegging', 'dildo riding', 'dildo sucking', 'fucking machine',
  'riding', 'cowgirl', 'reverse cowgirl', 'doggystyle', 'doggy style', 'missionary', 'spooning', 'prone bone',
  'standing sex', 'bent over', 'bending over', 'mating press', 'piledriver', 'amazon position', 
  'hardcore', 'rough sex', 'gangbang', 'orgy', 'threesome', 'foursome', 'group sex', 'mmf', 'ffm', 'mff',
  'swinger', 'swingers', 'swapping', 'cuckold', 'hotwife', 'bisexual', 'lesbian',
  'lesbians', 'scissoring', 'tribbing', 'strapon lesbian', 'gay', 'blowbang', 'creampie gangbang',
  'bdsm', 'bondage', 'femdom', 'maledom', 'domination', 'submissive', 'dominatrix', 'domme', 'slave', 'choking',
  'choke', 'spanking', 'slapping', 'hair pulling', 'gagging', 'facesit', 'humiliation', 'ballbusting', 'cbt',
  'trampling', 'foot worship', 'foot fetish', 'feet fetish', 'toe sucking', 'footsie', 'tickling', 'edging',
  'teasing', 'tease', 'striptease', 'stripping', 'strip', 'lapdance', 'twerking', 'dancing', 'dance', 'jiggling',
  'jiggle', 'bouncing', 'shaking', 'booty shake', 'wiggling', 'flashing', 'upskirt', 'downblouse', 'nipslip',
  'pissing', 'peeing', 'golden shower', 'watersports', 'squirt drinking', 'spitting', 'drooling', 'drool',
  'licking ass', 'ass licking', 'ass worship', 'tit worship', 'titty drop', 'tit drop', 'body worship',
  'role play', 'roleplay', 'stepmom', 'step mom', 'step sister', 'step brother', 'step dad', 'step daughter',
  'voyeur', 'exhibitionist', 'exhibitionism', 'flash', 
  'sleep sex', 'hypno', 'massage', 'sucking toes', 
  'sexting', 'joi', 'jerk off instruction', 'cei', 'handcuffs', 'blindfold', 'tied up',
  'shibari', 'suspension', 'clamps', 'nipple clamps', 'cumming', 'cum on feet',
  
  'yoga', 'ass slapping', 'ass clap', 'ass clapping', 'booty clap', 'throating',
] as const;

/** Where / how it happens: places, camera angle and shooting style. */
const SETTING = [
  'outdoor', 'outdoors', 'outside', 'public', 'public sex', 'beach', 'pool', 'poolside', 'hot tub', 'jacuzzi',
  'shower', 'bath', 'bathtub', 'bathroom', 'toilet', 'bedroom', 'couch', 'sofa', 'kitchen', 'living room',
  'office', 'school', 'classroom', 'gym', 'locker room', 'hotel', 'motel', 'car', 'car sex', 'backseat', 'truck',
  'bus', 'train', 'plane', 'boat', 'yacht', 'forest', 'woods', 'park', 'garden', 'balcony', 'rooftop',
  'street', 'alley', 'parking lot', 'elevator', 'stairs', 'garage', 'basement', 'attic', 'hallway', 'laundry',
  'restaurant', 'nightclub', 'party', 'festival', 'concert', 'camping', 'tent',
  'lake', 'river', 'waterfall', 'ocean', 'sauna', 'spa', 'dressing room', 'fitting room', 'changing room',
  'public toilet', 'dorm', 'apartment', 
  'sunset', 'sunrise', 'daylight', 'candlelight',
  'pov', 'point of view', 'close up', 'closeup', 'wide angle', 'selfie', 'mirror selfie', 'side view',
  'from behind', 'from below', 'from above', 'top view', 'over the shoulder', 'rear view', 'front view',
  'first person', 'third person', 'webcam', 'cam', 'camgirl', 'cam show', 'livestream', 'snapchat',
  'skype', 'facetime', 'vr', '360', 'hidden cam', 'spy cam', 'security cam', 'drone', 'gopro',
  'holiday', 'christmas', 'halloween', 'valentines', 'easter', 'summer', 'winter', 'vacation', 'honeymoon',
  'wedding', 'birthday', 'graduation', 'prom', 'cabin', 'ski', 'hot spring', 'onsen', 'glory hole',
  'sex club', 'swingers club', 'strip club', 'brothel', 'gloryhole', 'balcony sex', 'window sex', 'rooftop sex',
] as const;

/** About the video itself: source, format, quality, production. */
const META = [
  'amateur', 'amateurs', 'onlyfans', 'fansly', 'manyvids', 'pornhub', 'chaturbate', 'myfreecams',
  'tiktok', 'instagram', 'snapchat girl', 'reddit', 'twitter', 'telegram', 'patreon', 'justforfans', 'fanvue',
  'homemade', 'home video', 'sex tape', 'leaked', 'leak', 'exclusive', 'professional', 'studio',
  'ai generated', 'ai art', 'ai porn', 'deepfake', 'morphing',
  'compilation', 'compilations', 'loop', 'looping', 'looped', 'gif', 'full video', 'full scene',
  'trailer', 'preview', 'teaser', 
  'pmv', 'cmv', 'hmv', 'slow motion', 'slowmo', 'timelapse', 'time lapse',
  '60fps', '30fps', '4k', '1080p', 'vertical', 'vertical video',
  'horizontal', 'square', 'photoset', 'caption', 'captions',
  'meme', 
  'vintage', 'retro', 'classic', 
  'anime', 'hentai', 'cartoon', 'animation', 'animated', '3d', 'sfm', 'blender', 'rule 34', 'rule34', 'ecchi',
  'cosplay', 'gaming porn', 'fortnite', 'overwatch', 'genshin', 'league of legends', 'pokemon',
  'furry', 'reality', 'verified', 'verified amateurs',
  'verified couples', 'couple', 'couples', 'girlfriend', 'gf', 'wife', 'husband', 'boyfriend', 'bf', 'real couple',
  'bts', 'behind the scenes', 'bloopers', 'outtakes', 
  'porn gifs', 'sexy gif', 'nsfw gif', 'verified model', 'celebrity',
  'celeb', 'celebs', 'influencer', 'youtuber', 'streamer', 'twitch', 'tiktoker', 
] as const;

const GROUPS: ReadonlyArray<[Category, readonly string[]]> = [
  ['body', BODY],
  ['act', ACT],
  ['setting', SETTING],
  ['meta', META],
];

function compile(): Record<string, Category> {
  const out: Record<string, Category> = Object.create(null);
  for (const [category, tags] of GROUPS) {
    for (const tag of tags) {
      const key = normalizeTag(tag);
      if (key && !(key in out)) out[key] = category; // the first listing wins
    }
  }
  return out;
}

/** Normalized tag key -> category, for common RedGifs tags. Unlisted tags are 'general'. */
export const BUILTIN_CATEGORIES: Readonly<Record<string, Category>> = Object.freeze(compile());
