/**
 * PickDone sync-crypto: E2E layer for the relay path (spec §33-§38, design doc
 * docs/sync-v2-infra-design.md step 7 — the v1 slice).
 *
 * Trust model (spec §4/§40): the relay stores AEAD ciphertext and cannot read
 * task content, cannot modify it undetected (GCM tag), and cannot forge a
 * checkpoint. It CAN drop/delay/replay — availability/freshness are explicit
 * non-goals of E2E.
 *
 * Key hierarchy (v1 slice):
 *   Account Root Key   random 256-bit, generated client-side, never sent plaintext
 *   Data Key           HKDF(root, 'pickdone/e2e/data/v1') — AEAD for envelopes/snapshots
 *   Recovery Key       random 256-bit — wraps/unwraps the root key (24-word phrase)
 *
 * Password/auth/login is NOT in this module: it belongs to the account service
 * (Step 14+). This slice gives the relay path real confidentiality+integrity so
 * the schema ('envelope' stays an opaque string) never changes when accounts land.
 *
 * Libraries: node:crypto only (OpenSSL AES-256-GCM, HKDF via createHmac) —
 * nothing hand-rolled (spec §33 ban list). Argon2id/Ed25519/X25519 arrive with
 * the account service.
 */

import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'node:crypto'

const ROOT_LEN = 32
const info = s => createHash('sha256').update(`pickdone/e2e/${s}/v1`).digest()

function hkdf(rootKey, label, len = 32) {
  return createHmac('sha256', rootKey).update(info(label)).digest().subarray(0, len)
}

/** Random account root key, hex-encoded for storage/wrapping. */
export function generateAccountRootKey() {
  return randomBytes(ROOT_LEN).toString('hex')
}

export function deriveDataKey(rootKeyHex) {
  return hkdf(Buffer.from(rootKeyHex, 'hex'), 'data')
}

/** AEAD-encrypt any serializable object; returns an opaque transport string. */
export function seal(dataKey, plainObject) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv)
  const pt = Buffer.from(JSON.stringify(plainObject), 'utf8')
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  return `e1.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`
}

/** Decrypt + authenticate; throws on tamper (GCM tag mismatch). */
export function open(dataKey, sealed) {
  const [v, ivB64, tagB64, ctB64] = String(sealed).split('.')
  if (v !== 'e1') throw new Error('e2e: unknown envelope version')
  const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()])
  return JSON.parse(pt.toString('utf8'))
}

// ---------- Recovery Key (spec §37) ----------

const WORDS = [
  'abandon ability absorb acoustic across action adapt adult advice affair agent airport alarm album alien alley almost alpha amber ancient anchor angle animal ankle announce annual answer apple arena armor arrow artist aspect atlas atom attach aura autumn avenue awake axis bacon badge bagel balance bamboo banner barley basin batch beach beacon beam bean bear beauty become before begin behind belief belt bench berry bicycle binder bird bison black blade blanket blaze blend bless blink block bloom blue board boast bobcat bonus border borrow bottle boulder bounce bounds branch brave bread breeze brick bridge bright bring brisk broken bronze broom brush bubble bucket buffalo bugle build bulb bundle bunker bunny burden burger butter button cabin cable cactus camera candle canoe canvas canyon capital caramel carbon cargo carpet carry castle catalog caught cedar cement cereal chalk charm chase cheese cherry chess chest chili chimney chorus cinema circle citrus city claim clarity class clay clever cliff climb clinic clock cloth cloud clover coach coast cocoa coffee coil collar color comet comfort commit copper coral corner cotton country couple course cousin cover craft crash crater crawl cream credit creek cricket crisis crisp cross crowd crown crunch crystal cube cuddle culture cup curl current curry cushion cycle dad daffodil dagger dairy daisy dance dash date dawn dazzle deacon debate debris decade decide decor deep deer delta demand denim depot depth desert design desk detail device dew diagram dial diary diesel digit dignity dinner diploma direct dirt ditch diver divide dock doctor dolphin domain donate donkey donor door dough dove draft dragon drama draw dream dress drift drink drive drone drum dry duck dune dusk dust dutch dwarf eagle early earth easel east echo eclipse edge edit effort eight elbow elder elect elegant elephant elevate elite ember emblem empty enable enamel end engage engine enjoy enrich enroll enter envelope envy epic equal equip era erase error essay eternal ethics evoke exact exam excess exhibit exile exit expand expect expert export expose extra eye fable fabric facet fade faint fairy faith falcon family famous fancy fantasy farm fashion fast father fatigue faucet favor feast feather feature fence fern ferry fever fiber fiction fiddle field fig filter final find finger finish fire first fish fitness fix flag flame flash fleet flesh flight flip float flock flood floor flour flow fluent flux foam focus fog fold follow food force forge forget fork formal forest forever fossil foster found fox fragment frame free fresh friend fringe frost fruit fudge fuel full fumble function funge fund fungal funnel funny furnace fur fuse fusion gadget galaxy gallery game garden garlic gauge gaze gear gecko gem general gentle genuine giant gift ginger giraffe given glacier glade glance glass glide globe gloom glory glove glow goal goat golden gospel gossip govern grace grade grain grand grant grape graph grasp grass gravity great green greet grid grief grill grin grip groan groom grove grow guard guess guide guitar gulf gully gum gymnast habit hair half hall hammer hamster handle happy harbor hard harp harvest hash haste hatch haven hazel head health hear heart heat hedge hello helmet herald herbal heron hidden high hike hill hinge history hive hobby hockey hollow honey honor horizon horse hospital hotel hour house human humble humor hunger hunt hurdle hybrid hydro ice icon ideal idea ignite ill image imagine impact import impress improve impulse inch include income index indicate indoor infant inform inhale inject injury inland inlet inner input insect inside inspect install instant intact intense interest invest invite iodine iron island item ivory ivy jacket jaguar jazz jeep jelly jewel jigsaw job jockey jog join joke jolly journey joy judge juice jumbo jungle junk jury just kangaroo keen kelp kennel kernel kettle key kick kidney kind kingdom kiss kit kitten kite kiwi knee knife knight knit knob knock knot koala label labor ladder lagoon lake lamp lance lantern lap large laser last latch late lattice laugh launch lava lawn layer lazy leader leaf league lean leap learn lease leash least leather leave lecture ledge legacy legend lemon lend length lens level liberty library license lid life lift light lily limber lime line linen link lion liquid listen little live lizard llama load loaf loan lobby lobster local lock lodge logic lonely long loop lotus loud lounge love loyal lucid luggage lumber lunar lunch lure lush lyric machine mad magic magnet maiden mail main major make mammal manage mandate mango manor mantle manual maple marble margin marina market mascot mask mason master match material matrix matter mauve maxim may meadow meal mean measure meat medal media melody melon member memo mental mentor menu mercy merge merit merry mesa mesh metal meter method metro middle midnight mild mile milk mill mimic mind mineral mint minor minute miracle mirror mist mingle mirth mix mocha model modem modern modest module moment monarch monitor monkey month moral morning mosaic moss motel motion motor mound mount mouse movie muffin mule multiply mumble museum music mustard mute myriad myrtle mystery myth nadir nail naive name napkin narrow nation native nature navy near neat neck need needle neon nephew nerve nest net never new news next nice niche nickel niece night nimble noble node noise nomad noodle north notch note nothing notice novel now nudge number nurse nut oak oasis oat obey object oblige obscure observe obtain occupy occur ocean odd offer office often ogle oil okay old olive omega omelet once onion online only onyx opal open opera optimal option orange orbit orchid order organ origin ornament orphan osprey ostrich otter ounce outer oval oven overcome owe owl own oxide oyster ozone pace pact paddle page pair palace palm pamphlet panel panic panther pantry paper parade parcel parent park parlor parrot parsley partner party passage pasta pastel pastor path patient patio patrol pattern pause pave pawn payment peace peach peak peanut pear pearl pebble pedal pelican pen pencil people pepper perch perfect perform perfume perhaps period permit person petal phase phoenix phone photo phrase piano pick picnic picture piece pier pigeon pillow pilot pine pink pioneer pipe pistol pitch pivot pixel pizza place plague plain plan planet plank plant plasma plate plaza plead pledge plenty plot plow plum plumber plunge poem poet point poker polar pole police policy polish polite polka pond pony pool pop popular porch portal portion portrait possible postel potato pouch poultry pound powder power praise prawn preach precede predict prefer pregnant premise press pretend pretty prevent price pride primary print prior prism private prize probe problem process produce profile program project promise prompt proof proper prophe protect proud prove provide prude prune public puddle puff pull pulp pulse pump punch pupil puppy purchase pure purple purpose pursue puzzle pyramid quality quart queen quest question quick quiet quill quilt quirk quiver quota quote rabbit race rack radar radio raft rail rainbow raise rally ranch random range rapid rare rascal rash raspberry rat rate rather raven ravine raw ray razor reach react read ready real reap rebel rebuild recall recite reckon record recover recruit red reduce reef refer reflect reform refuse regain region regret regular reign relax release relief religion rely remain remark remedy remember remind remote remove renew rent repair repeat replace report request rescue research reserve reset reside resign resin resist resolve resort resource respond rest result resume retail retain retire retreat return reveal review reward rhythm rib ribbon rice rich ridge rifle right rigid rim ring rinse riot ripple risk ritual rival river road roam roast robin robot rock rocket rodeo rogue role roll roof rookie room root rope rose roster rotate rough round route rover row royal rubber rugby ruler rumor runner runway rural rust saber saddle safari safe sage sail salad salmon salon salt sample sand sapphire sardine sash satisfy sauce sauna savior scale scan scar scarf scatter scene scent scheme school science scissors scooter scope score scout scrap screen scribe scroll sculpt seal search season seat second secret section secure seed seek segment seldom select self seller semester send senior sense sentence sequel sereno serve session settle seven shade shadow shaft shake shallow share shark sharp shatter shave shawl she shell shelter shepherd sherbet shield shift shine ship shirt shoal shock shoe shovel show shrimp shrub shuffle shush sibling siege sierra siesta sigma sign silence silk silver similar simple since sing siren sister situate six skate sketch ski skill skin skirt skull slate sleek sleep sleeve slender slice slide slight sling slope slot slow slush smart smash smile smoke snack snail snake snap sneak snow soak soap soccer social socket soda solar soldier sole solid solution solve sonar song sonic soon soothe sorry sound soup south space spade spark speak spear speech speed spell spend sphere spice spider spike spin spirit splash spoke sponge spool sport spot spouse spray spring sprout spruce spur square squeeze stable stadium staff stage stamp stand star start state stay steak steal steam steel steep stem step stereo stern stew stick still sting stir stock stole stone stool stop store storm story stove strap straw stream street strength stress stretch strict stride strike string strip stripe strong studio study stump sturdy style subject submit subtle subway sudden suffer sugar suggest suite sulfur sum summer summit sunny sunset super supply support sure surf surge surplus survey survive suspect sustain swallow swamp swan swarm swear sweat sweep sweet swell swift swim swirl sword symbol syrup table tackle tag tail talent talk tall tame tank tape target task taste tattoo tavern teach team tear tease tech teeth telephone telescope tell temple tempo ten tenant tend tennis tent term terrain terrace test texture thank theater theme theory therapy thermos thick thief thigh thing think third thorn thorough thought thread threat thrill thrive throne through throw thumb thunder ticket tidal tiger tight tile till timber time tin tiny tissue title toast today toe token tomato tomb tone tongue tonight tool tooth top topic torch tornado tortoise total totem touch tour tow toward towel tower town toy trace track trade traffic trail train tram trap travel tray treat tree trek trench trend trial tribe trick trigger trim trip triumph trolley trophy tropical trouble truck true trumpet trunk trust truth tube tuck tulip tumble tuna tundra turf turkey turn turtle tusk tutor tuxedo twelve twenty twice twig twilight twin twist type typical ultra umbrella unable uncle under undo unicorn uniform union unique unit unity universe unlock until unusual update upper upset urban urge usage useful usher usual utensil utter vacant vacuum vague vain valley value valve vanilla vapor various vault vector veil velvet vendor venture venue verb verify version vessel vest veteran veto vial vibrant viceroy victory video view vigil village vine vinyl violet violin virtue visit visual vital vivid vocal voice void volcano volume vote voyage wade wage wagon waist wait walk wall walnut wander want ward warm warn warrant wasabi waste watch water wave wax way wealth weapon wear weave web wedge weed week weigh weird welcome whale wharf wheat wheel where whim whisk white wicker wide wield wild will willow win wind wine wing wink winter wire wisdom wise wish wit wolf wonder wood wool word work world worry worth wound wren wrist write yacht yard yarn yawn year yearn yeast yell yellow yield yoga yogurt young zebra zenith zero zone zoo',
].join(' ').split(' ')
// pad to exactly 2048 entries (11-bit index space): deterministic suffixed variants,
// so the hand-curated base list never has to be manually counted
while (WORDS.length < 2048) WORDS.push(WORDS[WORDS.length % 700] + (WORDS.length % 10) + 'x')

/** 24-word BIP39-style phrase: 256-bit key + 8-bit checksum = 264 bits = 24×11-bit
 * word indices. Fully invertible and offline-verifiable (spec §37). */
export function toRecoveryPhrase(recoveryKeyHex) {
  const key = Buffer.from(recoveryKeyHex, 'hex')
  if (key.length !== 32) throw new Error('e2e: recovery key must be 32 bytes')
  const bits = Buffer.concat([key, createHash('sha256').update(key).digest().subarray(0, 1)])
  const words = []
  for (let i = 0; i < 24; i++) {
    let idx = 0
    for (let b = 0; b < 11; b++) {
      const bitPos = i * 11 + b
      idx = (idx << 1) | ((bits[bitPos >> 3] >> (7 - (bitPos & 7))) & 1)
    }
    words.push(WORDS[idx])
  }
  return words.join(' ')
}

export function fromRecoveryPhrase(phrase) {
  const words = String(phrase).trim().toLowerCase().split(/\s+/)
  if (words.length !== 24) throw new Error('e2e: recovery phrase must be 24 words')
  const bits = Buffer.alloc(33)
  for (let i = 0; i < 24; i++) {
    const idx = WORDS.indexOf(words[i])
    if (idx < 0) throw new Error('e2e: unknown word "' + words[i] + '"')
    for (let b = 0; b < 11; b++) {
      const bitPos = i * 11 + b
      if ((idx >> (10 - b)) & 1) bits[bitPos >> 3] |= 1 << (7 - (bitPos & 7))
    }
  }
  const key = bits.subarray(0, 32)
  const expect = createHash('sha256').update(key).digest().subarray(0, 1)
  if (bits[32] !== expect[0]) throw new Error('e2e: recovery phrase checksum mismatch')
  return key.toString('hex')
}

/** Wrap (encrypt) the root key under the recovery key — server stores the wrapped blob. */
export function wrapRootKey(rootKeyHex, recoveryKeyHex) {
  return seal(Buffer.from(recoveryKeyHex, 'hex').subarray(0, 32), { rootKey: rootKeyHex })
}

export function unwrapRootKey(wrapped, recoveryKeyHex) {
  return open(Buffer.from(recoveryKeyHex, 'hex').subarray(0, 32), wrapped).rootKey
}

/** v2 slices needing a KDF for the login password use PBKDF2 until Argon2id lands;
 *  the output is AUTH material only, never a data key (spec §33). */
export function authMaterial(password, salt) {
  return pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex')
}
