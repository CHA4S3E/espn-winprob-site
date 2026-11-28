// desk-lines.js -- everything the News Desk says.
//
// Every on-air line is assembled from three parts: an OPENER (how the anchor
// leads in), a CORE (the actual news, with the live numbers filled in) and a
// TAG (the anchor's closing remark). Each event type has its own cores, and
// each studio has its own voice:
//   pro    -- Branford: polished, big-network delivery
//   casual -- Family League: laid-back, joking around on the couch
// Openers x cores x tags gives thousands of combinations per event type, and
// a per-day memory (saved on this device) skips anything already said today,
// so a line repeating on the same day is rare.
//
// Placeholders: {T} team, {O} opponent, {P} win %, {S} score, {OS} opp score,
// {M} margin, {PRE} pregame %, {SW} swing, {MARK} milestone, {PL} player,
// {POS} position, {PRO} NFL team, {PTS} player points, {D} points just added,
// {Y} yards, {L} league, {G} NFL game, {N} count.
(function () {
  'use strict';

  // ---------------------------------------------------------------- openers
  const OPEN = {
    pro: {
      hype: ['Breaking now:', 'Stop what you’re doing.', 'Huge moment here.', 'This just in:', 'Big development.', 'We have movement.', 'Look at this.', 'Here we go.', 'Hold on a second —', 'You have to see this.', 'Alert from the data desk:', 'Major news out of {L}:', 'Fresh off the wire:', 'Turn it up.', 'Developing story:', 'Right now in {L}:', 'Eyes on this one.', 'We interrupt the rundown:', 'Massive swing alert.', 'Just crossing the desk:', 'Mark the time.', 'Let’s go to the numbers.', 'Pull up the board —', 'Our model just moved.', 'Signal from the war room:'],
      calm: ['Checking in on', 'Quick update:', 'Around {L}:', 'A note from the desk:', 'Keeping tabs on', 'Worth a look:', 'Meanwhile,', 'Elsewhere in {L},', 'On the board:', 'From the research team:', 'One more for you:', 'Let’s update', 'A quick look at', 'As we’ve been tracking,', 'Status report:', 'For the record,', 'Here’s where we stand:', 'Taking stock:', 'Updating the rundown:', 'File this away:'],
      bad: ['Ouch.', 'Trouble brewing.', 'Not ideal.', 'A tough development.', 'That’s going to sting.', 'Red flag.', 'Uh-oh.', 'Concern on the board.', 'Rough news.', 'Not what they drew up.', 'That’s a gut punch.', 'Warning lights are on.', 'Brutal timing.', 'A costly moment.', 'The wrong kind of headline.'],
      final: ['That’s a final.', 'It’s official.', 'In the books:', 'Final whistle in {L}:', 'Put a bow on it:', 'Game, set, match:', 'Ballgame.', 'Closing the book:', 'The result is in:', 'Locked and final:', 'The verdict:', 'Signed, sealed, delivered:', 'That one’s over.', 'Final from {L}:', 'Stamp it.'],
    },
    casual: {
      hype: ['OH MY.', 'Wait wait wait —', 'Okay, everybody look up.', 'Hold my snacks.', 'Somebody get the group chat.', 'No way.', 'Are you seeing this?!', 'Big news, folks!', 'Stop scrolling.', 'Well, well, well.', 'Pause the dishes!', 'Grandma just yelled at the TV.', 'Somebody’s gonna be texting about this.', 'Oh it’s HAPPENING.', 'Hoo boy.', 'Call the neighbors.', 'Heads up, family!', 'Spill the chips, this is big.', 'Everybody gather round.', 'Not a drill!', 'I nearly dropped my coffee.', 'Turn it up, turn it up!', 'Okay okay okay.', 'Plot twist!', 'Excuse me?!'],
      calm: ['Quick peek at', 'So anyway,', 'Over in the Family League,', 'Just so you know,', 'Little update:', 'Checking on', 'Meanwhile on the couch,', 'Fun fact:', 'Let’s see how', 'By the way,', 'Small news:', 'Catching up with', 'Peeking at the scores —', 'For those just walking in,', 'In case you missed it,', 'While we wait on the pizza,', 'Low-key update:', 'Housekeeping:', 'Here’s the scoop:', 'Real quick:'],
      bad: ['Yikes.', 'Oof.', 'Oh no.', 'Welp.', 'Big sad.', 'That’s rough, buddy.', 'Somebody hug them.', 'Not great, Bob.', 'Uh oh, spaghettio.', 'Oh honey.', 'Ruh-roh.', 'Pour one out.', 'Brutal.', 'That’s gonna leave a mark.', 'Sending thoughts and prayers.'],
      final: ['And that’s that!', 'It’s over!', 'Final score, folks:', 'Game over, man:', 'Done and dusted:', 'Put it on the fridge:', 'Wrap it up:', 'The dust has settled:', 'Bring it home:', 'Official-official:', 'Final answer:', 'Lights out:', 'Bring out the trophy (the small one):', 'Pencils down:', 'All finished:'],
    },
  };

  // ---------------------------------------------------------------- tags
  const TAG = {
    pro: {
      hype: ['What a turn.', 'The momentum is real.', 'Stay with us.', 'This race just changed.', 'You can feel it.', 'That changes everything.', 'Buckle up.', 'Statement made.', 'Somebody had to step up.', 'And the building shakes.', 'Clutch.', 'That’s a season-defining sequence.', 'Remember this one.', 'Next possession matters.', 'This league never sleeps.', 'Not done yet.', 'Electric.', 'That’s winning football.', 'Pressure applied.', 'Tell your friends.'],
      calm: ['We’ll keep watching.', 'More as it develops.', 'Noted.', 'Long way to go.', 'Something to monitor.', 'Stay tuned.', 'We’ll circle back.', 'The board keeps moving.', 'Plenty of football left.', 'Watch this space.', 'That’s the latest.', 'Back to you.', 'Keep an eye on it.', 'Patience required.', 'The numbers don’t lie.'],
      bad: ['Tough break.', 'Time to regroup.', 'They’ll need a response.', 'That hurts.', 'Not how you draw it up.', 'Clock is ticking.', 'Adversity check.', 'A long afternoon now.', 'Pressure mounts.', 'Next man up.', 'That one will linger.', 'Can they answer?'],
      final: ['On to next week.', 'Well played.', 'What a battle.', 'Write it in ink.', 'Standings will reflect it.', 'Congrats to the winners.', 'That’s how it’s done.', 'A deserved result.', 'History made, one week at a time.', 'Next.', 'Film session tomorrow.', 'Respect to both sides.'],
    },
    casual: {
      hype: ['Love to see it!', 'Somebody’s doing a happy dance.', 'Screenshot this.', 'The group chat is gonna explode.', 'We LOVE chaos.', 'Get the confetti.', 'Chef’s kiss.', 'Somebody owes somebody a pizza.', 'Absolutely bonkers.', 'Is it hot in here?', 'Hoo!', 'Cue the dance music.', 'I’m screaming.', 'What a time to be alive.', 'Unreal.', 'Put it on a T-shirt.', 'Mom would be proud.', 'Somebody call ESPN. Wait, that’s us.', 'The couch is shaking.', 'I need a minute.'],
      calm: ['Cool cool cool.', 'Carry on.', 'Okay, back to snacks.', 'We’ll keep you posted.', 'Lots of football left.', 'Stay comfy.', 'Anyway!', 'Moving on.', 'Just vibing.', 'More soon.', 'Hang tight.', 'Fingers crossed.', 'We’ll see!', 'That’s the tea.', 'Pass the dip.'],
      bad: ['Hang in there.', 'There’s always next week.', 'Somebody get them a blanket.', 'We still love you.', 'Sad trombone.', 'Character building!', 'Deep breaths.', 'That’s gonna be a quiet ride home.', 'Thoughts and prayers.', 'Hug incoming.', 'It’s only fantasy. (It’s not only fantasy.)', 'Big oof energy.'],
      final: ['Bragging rights secured.', 'Good game, everybody!', 'Somebody’s doing dishes tonight.', 'Group hug.', 'Frame it.', 'Victory lap!', 'Let the trash talk begin.', 'Bring it up at Thanksgiving.', 'Gold star!', 'Hugs for the loser.', 'That’s family football.', 'See you next week!'],
    },
  };

  // ---------------------------------------------------------------- cores
  // head = short banner text; body = what the anchor says. Mood picks the opener/tag family.
  const CORES = {
    lead_change: { mood: 'hype', pro: [
      ['{T} TAKE THE LEAD', '{T} flip it on {O}. They’re now {P}% to win.'],
      ['LEAD CHANGE: {T}', 'The matchup turns: {T} move in front of {O}, {P}% and climbing.'],
      ['{T} SURGE AHEAD', 'A new favorite — {T} take over from {O} at {P}%.'],
      ['NEW FAVORITE', '{T} are now the pick over {O}. Our model: {P}%.'],
      ['{T} GRAB CONTROL', '{T} wrestle control away from {O} and sit at {P}%.'],
      ['THE TABLES TURN', 'Momentum has swung to {T}. {O} were up; now it’s {P}% {T}.'],
      ['{T} OVERTAKE {O}', '{T} overtake {O} in the win-probability race: {P}%.'],
      ['FLIP!', 'It’s flipped. {T} {P}%, {O} chasing.'],
      ['{T} IN FRONT', 'After trailing earlier, {T} now lead {O} — {P}% to win.'],
      ['SEESAW IN {L}', 'Back and forth we go: {T} edge ahead of {O}, {P}%.'],
    ], casual: [
      ['{T} JUST TOOK THE LEAD!', '{T} sneak past {O}! They’re at {P}% now.'],
      ['UH OH, {O}', '{T} are winning now. {P}% to be exact. Sorry {O}.'],
      ['SWITCHEROO!', 'Remember when {O} were winning? Yeah, {T} {P}% now.'],
      ['{T} SAID "MY TURN"', '{T} are in front of {O}. {P}%, baby!'],
      ['FLIP FLOP!', 'Flip! {T} lead {O}. {P}% and feeling good.'],
      ['LOOK WHO’S WINNING', 'Look who’s winning now — it’s {T}! {P}%.'],
      ['{T} ARE BACK IN IT', 'Back in it AND in front: {T} over {O}, {P}%.'],
      ['NEW LEADER ALERT', '{T} take over! {O} better get those players going. {P}%.'],
      ['TABLES TURNED', 'The tables have turned on {O}. {T} {P}%.'],
      ['PLOT TWIST', 'Plot twist: {T} are favorites now at {P}%.'],
    ] },
    big_swing: { mood: 'hype', pro: [
      ['{SW}-POINT SWING', 'A {SW}-point swing in win probability — {T} up to {P}% against {O}.'],
      ['MOMENTUM SHIFT', 'Massive shift: {T} gain {SW} points of win probability on {O}.'],
      ['{T} SURGE', '{T} rip off a {SW}-point surge in the model. Now {P}%.'],
      ['THE NEEDLE MOVES', 'The needle jumps {SW} points toward {T}. {O} feeling it.'],
      ['HUGE SWING IN {L}', '{T} vs {O}: {SW} points of win probability changed hands.'],
      ['{O} REELING', '{O} drop {SW} points in a hurry. {T} now {P}%.'],
    ], casual: [
      ['WHOA, {SW} POINTS!', 'That matchup just swung {SW} points toward {T}! {P}% now.'],
      ['{T} ARE COOKING', '{T} just cooked {O} for a {SW}-point swing.'],
      ['BIG MOOD SWING', '{T} vs {O} just had a mood swing: {SW} points. {T} {P}%.'],
      ['THE METER JUMPED', 'The win meter jumped {SW} points for {T}. Whoa.'],
      ['{O} JUST FELT THAT', '{O} just lost {SW} points of hope. {T} {P}%.'],
      ['ZOOM ZOOM', 'Zoom! {T} climbed {SW} points in no time.'],
    ] },
    upset_watch: { mood: 'hype', pro: [
      ['UPSET WATCH', '{T} started at just {PRE}% — now they’re {P}% to beat {O}.'],
      ['UPSET ALERT: {T}', 'Underdog alert: {T}, {PRE}% at kickoff, now lead {O} at {P}%.'],
      ['{O} ON UPSET WATCH', 'Favorites {O} are in real danger. {T} up to {P}% from {PRE}%.'],
      ['DOG IS BARKING', 'The underdog is barking: {T} {P}% after starting at {PRE}%.'],
      ['STUNNER BREWING', 'A stunner could be brewing — {T} over {O}, {P}%.'],
      ['UNDERDOG RISING', '{T} were given {PRE}% this morning. Now: {P}%.'],
    ], casual: [
      ['UPSET WATCH!!', '{T} were only {PRE}% to win and now they’re at {P}%! Get the popcorn.'],
      ['THE UNDERDOG IS EATING', '{T} came in at {PRE}%. Now {P}%. {O}, you okay?'],
      ['{O} IS SWEATING', '{O} were the favorites. Were. {T} now {P}%.'],
      ['CINDERELLA ALERT', 'Somebody get {T} a glass slipper. {PRE}% to {P}%!'],
      ['NOBODY PICKED THIS', 'Nobody had {T} beating {O} on their bingo card. {P}% now.'],
      ['DOGGY STYLE (THE GOOD KIND)', 'Underdog {T} are barking at {O}: {P}%!'],
    ] },
    favorite_scare: { mood: 'bad', pro: [
      ['{T} IN A FIGHT', 'Heavy favorites at {PRE}%, {T} are now hanging on at {P}% against {O}.'],
      ['FAVORITE UNDER PRESSURE', '{O} are pushing {T} — what was {PRE}% is now {P}%.'],
      ['NOT SO FAST', 'Not so fast: {T} have slipped to {P}% versus {O}.'],
      ['{T} WOBBLING', 'The favorite is wobbling. {T} down to {P}% from {PRE}%.'],
    ], casual: [
      ['{T} GETTING NERVOUS', '{T} were {PRE}% sure of this. Now? {P}%. Sweaty palms!'],
      ['NOT A SURE THING', '{O} are giving {T} a real scare. {P}%.'],
      ['{T}, YOU GOOD?', '{T} went from {PRE}% to {P}%. Somebody check on them.'],
      ['TIGHTEN UP', '{T}, tighten up! {O} are coming. {P}%.'],
    ] },
    lock: { mood: 'calm', pro: [
      ['{T} ALL BUT LOCKED', '{T} are {P}% to beat {O}. Start engraving.'],
      ['{T} CLOSING IT OUT', '{T} have this one well in hand — {P}% over {O}.'],
      ['DONE DEAL (NEARLY)', 'Barring a miracle, it’s {T}. {P}%.'],
      ['{O} NEED A MIRACLE', '{O} are down to {OPCT}% against {T}.'],
    ], casual: [
      ['{T} GOT THIS', '{T} are {P}% to win. You can relax now, {T}.'],
      ['STICK A FORK IN IT', 'Stick a fork in {O}. {T} {P}%.'],
      ['IT’S A WRAP (ALMOST)', '{T} pretty much have it. {P}%. Sorry, {O}!'],
      ['{O} NEED A MIRACLE', '{O} at {OPCT}%? Time to pray.'],
    ] },
    nail_biter: { mood: 'hype', pro: [
      ['NAIL-BITER', '{T} and {O} separated by {GAP} with almost nothing left to play. {P}%.'],
      ['DOWN TO THE WIRE', 'Down to the wire: {T} vs {O}, a {GAP}-point game. {P}%.'],
      ['COIN FLIP IN {L}', 'This one’s a coin flip — {T} {P}%, {O} right there.'],
      ['PHOTO FINISH', 'Photo finish coming: {GAP} points between {T} and {O}.'],
    ], casual: [
      ['NAIL-BITER ALERT', '{T} and {O} are {GAP} points apart. I can’t watch. (I’m watching.)'],
      ['SO. CLOSE.', 'Only {GAP} points between {T} and {O}! {P}%.'],
      ['HEART RATE: HIGH', '{T} vs {O} is too close. {GAP} points. Somebody hold my hand.'],
      ['THIS ONE’S GONNA HURT SOMEBODY', '{T} and {O}, {GAP} apart. Grab a pillow.'],
    ] },
    score_mark: { mood: 'hype', pro: [
      ['{T} HIT {MARK}', '{T} crack {MARK} points — {S} and counting.'],
      ['{MARK}-POINT CLUB', '{T} join the {MARK}-point club this week: {S}.'],
      ['{T} PILING ON', '{T} are piling it on: {S} points.'],
    ], casual: [
      ['{T} HIT {MARK}!', '{T} just hit {MARK}! {S} points, wow.'],
      ['{MARK} CLUB!', 'Welcome to the {MARK} club, {T}! {S}.'],
      ['{T} ARE ON FIRE', '{T} are on fire: {S} points!'],
    ] },
    final: { mood: 'final', pro: [
      ['FINAL: {T} {S}, {O} {OS}', '{T} take care of business against {O}, {S} to {OS}.'],
      ['{T} WIN', '{T} defeat {O} {S}–{OS}.'],
      ['{T} GET IT DONE', '{T} close out {O}, {S}–{OS}. Margin: {M}.'],
      ['W FOR {T}', 'A {M}-point win for {T} over {O}.'],
    ], casual: [
      ['{T} WIN!', '{T} beat {O}, {S} to {OS}. Nice!'],
      ['GG {O}', '{T} take it, {S}–{OS}. Good game, {O}!'],
      ['ANOTHER ONE FOR {T}', '{T} win by {M}. Somebody update the fridge chart.'],
      ['{T} DID THE THING', '{T} did the thing! {S}–{OS} over {O}.'],
    ] },
    final_close: { mood: 'final', pro: [
      ['THRILLER: {T} BY {M}', '{T} survive {O} by just {M} points, {S}–{OS}.'],
      ['{T} ESCAPE', '{T} escape with a {M}-point win over {O}.'],
      ['BY A HAIR', 'By a hair: {T} {S}, {O} {OS}.'],
      ['INSTANT CLASSIC', 'An instant classic — {T} edge {O} by {M}.'],
    ], casual: [
      ['{T} BY A NOSE!', '{T} win by {M}! {M}! My heart!'],
      ['PHEW!', '{T} squeak past {O}, {S}–{OS}. Somebody check on {O}.'],
      ['THAT WAS TOO CLOSE', '{M} points. That’s it. {T} over {O}.'],
      ['SKIN OF THEIR TEETH', '{T} win by the skin of their teeth: {M}.'],
    ] },
    final_blowout: { mood: 'final', pro: [
      ['ROUT: {T} BY {M}', '{T} dismantle {O}, {S}–{OS}.'],
      ['{T} DOMINATE', 'Total domination: {T} by {M} over {O}.'],
      ['NO CONTEST', 'No contest — {T} {S}, {O} {OS}.'],
    ], casual: [
      ['{T} BODIED {O}', '{T} won by {M}. That’s not a game, that’s a lesson.'],
      ['CALL THE POLICE', '{T} beat {O} by {M}. That should be illegal.'],
      ['OOF, {O}', '{O} lost by {M}. We don’t talk about it.'],
    ] },
    final_upset: { mood: 'hype', pro: [
      ['UPSET! {T} STUN {O}', '{T}, {PRE}% at kickoff, knock off {O}, {S}–{OS}.'],
      ['SHOCKER IN {L}', 'Shocker: {T} take down {O}. They started at {PRE}%.'],
      ['THE UPSET IS COMPLETE', 'It’s complete — {T} over {O}, {S}–{OS}.'],
      ['GIANT SLAYERS', '{T} slay the giant. {PRE}% this morning, winners tonight.'],
    ], casual: [
      ['UPSET!!!', '{T} beat {O}!!! They were only {PRE}% to win! Wow!'],
      ['NOBODY SAW THIS COMING', '{T} over {O}, {S}–{OS}. Not one person picked this.'],
      ['DAVID BEAT GOLIATH', '{T} slingshot {O}! {PRE}% chance and they did it!'],
      ['THE DOGS WIN', 'The underdogs win! {T} beat {O}!'],
    ] },
    // ----- players
    player_pass_td: { mood: 'hype', pro: [
      ['TD: {PL}', '{PL} throws a touchdown for {T}. {PTS} fantasy points on the day.'],
      ['{PL} AIRS IT OUT', '{PL} finds the end zone through the air — {T} add {D}.'],
      ['PASSING TD, {T}', 'Touchdown pass from {PL}. {T} pick up {D}.'],
      ['{PL} DEALING', '{PL} is dealing for {T}: another TD, {PTS} points.'],
    ], casual: [
      ['{PL} TOUCHDOWN!', '{PL} just threw a TD for {T}! {PTS} points!'],
      ['YEET! {PL}', '{PL} yeeted it into the end zone. +{D} for {T}!'],
      ['{PL} SLINGING IT', '{PL} is slinging it for {T}: touchdown!'],
      ['SIX FOR {T}!', 'TD pass from {PL}! {T} get {D} more.'],
    ] },
    player_rush_td: { mood: 'hype', pro: [
      ['TD: {PL}', '{PL} punches it in on the ground for {T}. {PTS} points.'],
      ['{PL} FINDS PAYDIRT', '{PL} rushes for a score — {T} add {D}.'],
      ['RUSHING TD, {T}', '{PL} carries it in. Big boost for {T}.'],
      ['{PL} INTO THE END ZONE', '{PL} bulldozes into the end zone for {T}.'],
    ], casual: [
      ['{PL} SCORES!', '{PL} ran it in for {T}! {PTS} points now.'],
      ['RUN, {PL}, RUN!', '{PL} rumbles in for a TD! +{D} for {T}.'],
      ['{PL} SAID "MOVE"', '{PL} told the defense to move. Touchdown, {T}!'],
      ['GROUND AND POUND', 'TD on the ground from {PL}! {T} love it.'],
    ] },
    player_rec_td: { mood: 'hype', pro: [
      ['TD: {PL}', '{PL} hauls in a touchdown for {T}. {PTS} on the day.'],
      ['{PL} SCORES', '{PL} with the touchdown grab — {T} add {D}.'],
      ['RECEIVING TD, {T}', '{PL} finds the end zone. Huge for {T}.'],
      ['{PL} SIX', 'Six for {PL}. {T} feel that one.'],
    ], casual: [
      ['{PL} CAUGHT A TD!', '{PL} caught a touchdown for {T}! {PTS} points!'],
      ['HANDS! {PL}!', 'What hands! {PL} scores for {T}.'],
      ['{PL} IN THE END ZONE!', '{PL} is dancing in the end zone. +{D} for {T}!'],
      ['TOUCHDOWN, {PL}!', 'TD {PL}! {T} are happy campers.'],
    ] },
    player_dst_score: { mood: 'hype', pro: [
      ['DEFENSE SCORES', 'The {PL} defense delivers for {T}: +{D}.'],
      ['D/ST TOUCHDOWN', 'Defensive score from {PL} — a bonus for {T}.'],
    ], casual: [
      ['DEFENSE TD!', 'The {PL} defense scored! Free points for {T}!'],
      ['PICK SIX ENERGY', '{PL} D/ST just did something amazing. +{D} for {T}.'],
    ] },
    player_interception: { mood: 'bad', pro: [
      ['PICKED OFF: {PL}', '{PL} throws an interception. Costly for {T}.'],
      ['{PL} INTERCEPTED', 'Turnover — {PL} picked off. {T} lose ground.'],
      ['INT HURTS {T}', 'An interception from {PL} stings {T}.'],
    ], casual: [
      ['{PL} THREW A PICK', '{PL} threw it to the wrong team. Oops, {T}.'],
      ['NOOO {PL}', '{PL} got picked off. {T} are groaning.'],
      ['WRONG JERSEY, {PL}', '{PL} threw it to the other guys. Sad day for {T}.'],
    ] },
    player_fumble: { mood: 'bad', pro: [
      ['FUMBLE: {PL}', '{PL} puts it on the ground. {T} take the hit.'],
      ['{PL} COUGHS IT UP', 'Ball security issue for {PL} — bad news for {T}.'],
    ], casual: [
      ['BUTTERFINGERS!', '{PL} fumbled. {T} are not amused.'],
      ['{PL} DROPPED IT', 'Hold on to the ball, {PL}! Sorry, {T}.'],
    ] },
    player_big_play: { mood: 'hype', pro: [
      ['BIG PLAY: {PL}', '{PL} rips off a big gain — +{D} for {T}.'],
      ['{PL} EXPLODES', 'Explosive play from {PL}. {T} up {D}.'],
      ['{PL} BREAKS FREE', '{PL} breaks free for a chunk play: {PTS} points now.'],
    ], casual: [
      ['{PL} IS ZOOMING', '{PL} just zoomed for a big play! +{D} for {T}.'],
      ['LOOK AT {PL} GO', 'Look at {PL} go! {T} get {D} points.'],
      ['{PL} WITH THE JUICE', '{PL} has the juice today. {PTS} points!'],
    ] },
    player_fg_50: { mood: 'calm', pro: [
      ['{PL} FROM 50+', '{PL} drills one from 50-plus for {T}.'],
      ['LONG-RANGE BOOT', 'Big leg: {PL} connects from distance. +{D}.'],
    ], casual: [
      ['{PL} HAS A CANNON', '{PL} kicked it from 50+! Kickers are people too!'],
      ['BOOT IT!', '{PL} booted a long one for {T}!'],
    ] },
    player_pass_milestone: { mood: 'hype', pro: [
      ['{PL}: {Y} YARDS', '{PL} is over {MARK} passing yards for {T}.'],
      ['{PL} AIR RAID', '{MARK}-yard day for {PL}. {T} reaping the rewards.'],
    ], casual: [
      ['{PL} OVER {MARK}!', '{PL} has {Y} passing yards! Busy arm today.'],
      ['ARM DAY FOR {PL}', '{PL} is having an arm day: {Y} yards!'],
    ] },
    player_rush_milestone: { mood: 'hype', pro: [
      ['{PL}: {MARK}-YARD DAY', '{PL} crosses {MARK} rushing yards for {T}.'],
      ['{PL} GRINDING', '{PL} grinding to {Y} on the ground.'],
    ], casual: [
      ['{PL} {MARK} YARDS!', '{PL} has run for {Y} yards! Somebody get him a snack.'],
      ['LEG DAY FOR {PL}', '{PL} is having leg day: {Y} rushing yards!'],
    ] },
    player_rec_milestone: { mood: 'hype', pro: [
      ['{PL}: {MARK} RECEIVING', '{PL} over {MARK} receiving yards. {T} benefit.'],
      ['{PL} UNCOVERABLE', '{PL} cannot be covered today: {Y} yards.'],
    ], casual: [
      ['{PL} {MARK} YARDS!', '{PL} has {Y} receiving yards! Wide open all day.'],
      ['{PL} IS EVERYWHERE', '{PL} is everywhere: {Y} yards!'],
    ] },
    player_big_day: { mood: 'hype', pro: [
      ['{PL}: {PTS} POINTS', '{PL} is up to {PTS} for {T}. A monster day.'],
      ['MONSTER GAME: {PL}', '{PL} cracks {MARK} fantasy points. {T} rolling.'],
      ['{PL} CARRYING {T}', '{PL} is carrying {T} on his back — {PTS} points.'],
    ], casual: [
      ['{PL} IS HIM', '{PL} has {PTS} points. He is HIM.'],
      ['{PL} WENT OFF', '{PL} went off for {T}: {PTS} points!'],
      ['{PL} MVP?', '{PL} has {PTS}. MVP of the couch.'],
    ] },
    player_boom_final: { mood: 'hype', pro: [
      ['{PL} BOOMS', '{PL} finishes with {PTS} — projected for {PROJ}. Huge for {T}.'],
      ['SMASH: {PL}', 'Smash spot delivered: {PL} {PTS} points.'],
    ], casual: [
      ['{PL} SMASHED IT', '{PL} finished with {PTS}! He was only supposed to get {PROJ}!'],
      ['{PL} OVERDELIVERED', '{PL} overdelivered: {PTS} vs {PROJ} projected. Yay {T}!'],
    ] },
    player_dud: { mood: 'bad', pro: [
      ['{PL} QUIET DAY', '{PL} finishes with just {PTS} — projected for {PROJ}. Rough for {T}.'],
      ['DUD: {PL}', '{PL} never got going: {PTS} points.'],
      ['{T} LET DOWN', '{T} needed more than {PTS} from {PL}.'],
    ], casual: [
      ['{PL} DID NOTHING', '{PL} scored {PTS}. He was supposed to get {PROJ}. Sigh.'],
      ['WHERE WAS {PL}?', 'Has anyone seen {PL}? Just {PTS} points.'],
      ['{PL} TOOK A NAP', '{PL} took the day off: {PTS} points. Sorry {T}.'],
    ] },
    player_bench_boom: { mood: 'bad', pro: [
      ['LEFT ON THE BENCH', '{PL} put up {PTS} — on {T}’s bench.'],
      ['BENCH POINTS: {PL}', 'Painful: {PL} scored {PTS} sitting on {T}’s bench.'],
    ], casual: [
      ['BENCH REGRET', '{T} benched {PL}. {PL} scored {PTS}. Oops!'],
      ['{T}, WHY?', '{PL} scored {PTS} on {T}’s BENCH. We need to talk.'],
    ] },
    player_stat_correction: { mood: 'calm', pro: [
      ['STAT CORRECTION', '{PL} adjusted to {PTS} for {T}.'],
    ], casual: [
      ['STAT FIX', 'ESPN fixed {PL}’s points: {PTS} now.'],
    ] },
    // ----- record book ({REC} record name, {V} new value, {OLD} old value, {WHO} old holder, {WHEN} when it was set)
    record_watch: { mood: 'hype', pro: [
      ['RECORD WATCH: {T}', '{T} are projected for {V} — the league record is {OLD}, set by {WHO} ({WHEN}).'],
      ['{T} CHASING HISTORY', 'History in reach: {T} on pace for {V}. The mark to beat: {OLD}.'],
      ['RECORD IN PLAY', 'The {REC} record ({OLD}, {WHO}) is under threat — {T} projected for {V}.'],
      ['{T} EYE THE RECORD BOOK', '{T} could rewrite the record book: {V} projected, record {OLD}.'],
    ], casual: [
      ['{T} COULD MAKE HISTORY', '{T} are on pace for {V}! The record is {OLD} by {WHO}. Ooooh.'],
      ['RECORD WATCH!', 'Somebody call the record keepers: {T} projected for {V}. Record: {OLD}.'],
      ['{WHO}, WATCH OUT', '{WHO}’s record of {OLD} might fall — {T} are on pace for {V}!'],
      ['HISTORY ALERT', '{T} might break the {REC} record! {V} projected vs {OLD}.'],
    ] },
    record_broken: { mood: 'hype', pro: [
      ['NEW LEAGUE RECORD', '{T} set a new league record for {REC}: {V}. The old mark: {OLD} by {WHO} ({WHEN}).'],
      ['HISTORY: {T}', '{T} are in the record book — {REC}, {V}. Previous: {OLD}.'],
      ['RECORD SHATTERED', 'The {REC} record falls. {T}: {V}. {WHO}’s {OLD} is history.'],
      ['{T} MAKE HISTORY', 'For the first time in league history: {V}. {T} own the {REC} record.'],
    ], casual: [
      ['NEW RECORD!!!', '{T} just set the league record for {REC}: {V}! Sorry {WHO}, your {OLD} is toast.'],
      ['FRAME IT!', '{T} are officially in the record book: {V}! Old record: {OLD}.'],
      ['{WHO} JUST GOT DETHRONED', '{T} broke {WHO}’s {REC} record! {V} vs {OLD}.'],
      ['HISTORY, BABY!', 'New league record for {REC}: {T}, {V}!'],
    ] },
    // ----- playoffs ({RD} round just won, {NX} next round)
    advance: { mood: 'hype', pro: [
      ['{T} ADVANCE', '{T} beat {O} {S}\u2013{OS} and move on to the {NX}.'],
      ['{T} SURVIVE THE {RD}', '{T} take down {O}, {S}\u2013{OS}. Next stop: the {NX}.'],
      ['{T} MARCH ON', 'The {RD} is in the books \u2014 {T} over {O}, {S}\u2013{OS}.'],
      ['{O} ELIMINATED', '{T} send {O} home, {S}\u2013{OS}. {T} advance to the {NX}.'],
    ], casual: [
      ['{T} ARE MOVING ON!', '{T} beat {O}, {S}\u2013{OS}! On to the {NX}!'],
      ['BYE BYE, {O}', '{O} are out. {T} win {S}\u2013{OS} and keep dancing!'],
      ['{T} SURVIVE!', '{T} made it through the {RD}! {S}\u2013{OS} over {O}.'],
      ['ONE STEP CLOSER', '{T} are one step closer to the trophy. {S}\u2013{OS}!'],
    ] },
    champion: { mood: 'hype', pro: [
      ['{T} ARE CHAMPIONS', '{T} win the {L} championship, {S}\u2013{OS} over {O}.'],
      ['CHAMPIONS: {T}', 'The title belongs to {T}. Final: {S}\u2013{OS}.'],
      ['{T} WIN IT ALL', '{T} are the champions of {L}.'],
    ], casual: [
      ['{T} WON IT ALL!!!', '{T} are the champs! {S}\u2013{OS} over {O}! Group hug!'],
      ['CHAMPS!', 'Bow down to {T}, your {L} champions!'],
      ['THE TROPHY GOES TO {T}', '{T} beat {O} for the title. Bragging rights for a whole year!'],
    ] },
    // ----- clinch watch
    clinched: { mood: 'hype', pro: [
      ['{T} CLINCH', '{T} have clinched a playoff spot in {L}.'],
      ['{T} ARE IN', 'Punch the ticket: {T} are headed to the {L} playoffs.'],
      ['POSTSEASON BOUND: {T}', '{T} lock up a playoff berth.'],
    ], casual: [
      ['{T} ARE IN!!', '{T} made the playoffs! Party at their place!'],
      ['PLAYOFF BOUND!', '{T} just clinched! Somebody get the streamers.'],
      ['{T} PUNCHED THEIR TICKET', '{T} are officially playoff bound. Woo!'],
    ] },
    eliminated: { mood: 'bad', pro: [
      ['{T} ELIMINATED', '{T} have been eliminated from playoff contention.'],
      ['{T}\u2019S SEASON IS OVER', 'The math is final: {T} can no longer make the playoffs.'],
      ['NO POSTSEASON FOR {T}', '{T} are out of the playoff race.'],
    ], casual: [
      ['{T} ARE OUT', '{T} are officially out of the playoffs. There\u2019s always next year!'],
      ['NOOO {T}', '{T} got eliminated. Pour one out.'],
      ['{T}: SPOILER SEASON', '{T} can\u2019t make the playoffs, but they can still ruin someone else\u2019s week.'],
    ] },
    // ----- injuries + transactions ({S2} injury status, {PL} player, {A} add, {DR} drop, {T2} trade partner, {GET} received)
    player_injury: { mood: 'bad', pro: [
      ['INJURY: {PL} {S2}', '{PL} is listed {S2} \u2014 a starter for {T}, projected for {PROJ}.'],
      ['{T} LINEUP ALERT', '{T} starter {PL} is now {S2}.'],
      ['{PL} DOWNGRADED', '{PL} downgraded to {S2}. {T} will need a plan.'],
    ], casual: [
      ['UH OH: {PL} IS {S2}', '{PL} is {S2}! {T}, check your lineup!'],
      ['{T}, CHECK YOUR LINEUP', '{PL} just got listed {S2}. Swap him out!'],
      ['{PL} INJURY NEWS', '{PL} is {S2}. Fingers crossed, {T}.'],
    ] },
    txn_add: { mood: 'calm', pro: [
      ['{T} ADD {A}', '{T} pick up {A}{DROPTXT}.'],
      ['ROSTER MOVE: {T}', '{T} add {A}{DROPTXT}.'],
      ['WAIVER WIRE: {A} TO {T}', '{A} lands with {T}{DROPTXT}.'],
    ], casual: [
      ['{T} GRABBED {A}', '{T} picked up {A}{DROPTXT}. Sneaky!'],
      ['NEW GUY ALERT', '{A} joins {T}{DROPTXT}. Welcome to the family!'],
      ['{T} WENT SHOPPING', '{T} added {A}{DROPTXT}.'],
    ] },
    txn_trade: { mood: 'hype', pro: [
      ['TRADE: {T} AND {T2}', '{T} send {A} to {T2} for {GET}.'],
      ['BLOCKBUSTER IN {L}', 'Trade alert: {T} get {GET} from {T2} for {A}.'],
      ['THE DEAL IS DONE', '{T} and {T2} complete a trade \u2014 {A} for {GET}.'],
    ], casual: [
      ['TRADE!!', '{T} and {T2} made a trade! {A} for {GET}. Who won?'],
      ['DEAL OR NO DEAL? DEAL!', '{T} traded {A} to {T2} for {GET}.'],
      ['SWAP MEET', '{T} and {T2} swapped players: {A} for {GET}. Hmm.'],
    ] },
    // ----- NFL
    nfl_kickoff: { mood: 'calm', pro: [
      ['KICKOFF: {G}', '{G} is underway.'],
      ['WE’RE LIVE: {G}', 'Kickoff in {G}. Fantasy points are on the table.'],
    ], casual: [
      ['{G} STARTED!', '{G} just kicked off. Here we go!'],
      ['KICKOFF TIME', '{G} is on! Grab a seat.'],
    ] },
    nfl_final: { mood: 'calm', pro: [
      ['NFL FINAL: {G}', 'Final in the NFL: {G}.'],
      ['{G} IS FINAL', 'That one’s over: {G}. Those players are locked in.'],
    ], casual: [
      ['{G} IS OVER', 'Real football update: {G}. Done!'],
      ['FINAL: {G}', '{G} is final. Players from that game are all done.'],
    ] },
    nfl_overtime: { mood: 'hype', pro: [
      ['OVERTIME: {G}', 'Bonus football! {G} heads to overtime.'],
    ], casual: [
      ['OVERTIME!!', '{G} is going to OVERTIME! Free football!'],
    ] },
  };

  // Segment intros and handoffs (no live numbers needed beyond names).
  const SEGMENTS = {
    spotlight: { pro: ['Our featured matchup', 'Game of the moment', 'Spotlight game', 'The marquee matchup', 'Center stage', 'Main event'], casual: ['The big game', 'Everybody’s watching this one', 'Game of the day', 'The one that matters', 'Featured fight', 'The good one'] },
    scoreboard: { pro: ['Around the league', 'League scoreboard', 'Every matchup, right now', 'The full board', 'Scores across {L}'], casual: ['Everybody’s scores', 'How everyone’s doing', 'The whole family', 'Scoreboard time', 'Who’s up, who’s down'] },
    standings: { pro: ['If the season ended now', 'Playoff picture', 'Standings impact', 'Race to the postseason', 'The playoff line'], casual: ['Who’s making the playoffs', 'If it ended right now', 'The standings', 'Playoff peek', 'Bragging rights board'] },
    players: { pro: ['Top performers', 'Player watch', 'Who’s carrying their teams', 'The stat sheet', 'Stars of the week'], casual: ['Who’s balling', 'MVP watch', 'Players of the day', 'The heroes (and zeros)', 'Who’s doing what'] },
    nfl: { pro: ['Around the NFL', 'The real games', 'NFL scoreboard', 'Live from the league'], casual: ['Real football', 'The actual NFL', 'What the pros are doing', 'NFL check-in'] },
    rundown: { pro: ['The rundown', 'Top stories', 'Latest headlines', 'What you missed'], casual: ['The latest gossip', 'What’s happening', 'News roundup', 'Catch me up'] },
    preview: { pro: ['Matchup preview', 'This week\u2019s slate', 'Tale of the tape', 'The card'], casual: ['This week\u2019s games', 'Who\u2019s playing who', 'The lineup', 'Coming up'] },
    picks: { pro: ['Desk picks', 'Our picks', 'The predictions', 'Lock it in'], casual: ['Our picks', 'Bold predictions', 'Who we got', 'Crystal ball'] },
    countdown: { pro: ['Countdown to kickoff', 'Kickoff clock', 'Almost game time'], casual: ['Almost time!', 'Kickoff countdown', 'Get your snacks ready'] },
    scenarios: { pro: ['Showdown scenarios', 'What has to happen', 'It comes down to this', 'The final drive'], casual: ['Here\u2019s the deal', 'What needs to happen', 'It all comes down to\u2026', 'Nail-biter math'] },
    clinch: { pro: ['Clinch watch', 'Playoff math', 'Magic numbers', 'Race to the postseason'], casual: ['Who\u2019s in, who\u2019s out', 'Playoff math', 'Clinch watch', 'The playoff race'] },
    news: { pro: ['Injury & news wire', 'Injury report', 'News desk', 'Around the roster'], casual: ['Injury report', 'News and boo-boos', 'Who\u2019s hurt', 'The latest'] },
    transactions: { pro: ['Transaction wire', 'Roster moves', 'Waiver wire report', 'Front office'], casual: ['Who picked up who', 'Roster shuffles', 'Waiver wire', 'Trades & pickups'] },
    leaders: { pro: ['Stat leaders', 'Luck & consistency', 'The numbers behind the standings', 'Analytics desk'], casual: ['Lucky & unlucky', 'Fun stats', 'The nerd corner', 'Numbers that matter'] },
    whip: { pro: ['Whip-around', 'Live look-in', 'Around the horn', 'Quick hits'], casual: ['Checking in!', 'Quick peek', 'Look-in', 'Speed round'] },
    need: { pro: ['What they need', 'Path to victory', 'The comeback math', 'Do the math', 'Still alive'], casual: ['What it’s gonna take', 'Can they do it?', 'Comeback math', 'Still got a shot?', 'Hope-o-meter'] },
    records: { pro: ['The record book', 'League history', 'All-time marks', 'By the numbers: all time'], casual: ['The family record book', 'Hall of fame (and shame)', 'Who holds the records', 'Bragging rights forever'] },
    recap: { pro: ['Weekly recap', 'The week in review', 'Last week’s highlights'], casual: ['Last week, real quick', 'Previously on…', 'The week that was'] },
    preview: { pro: ['Matchup preview', 'Looking ahead', 'On deck', 'The week ahead'], casual: ['Coming up', 'What to watch', 'Sneak peek', 'Next up'] },
  };
  const HANDOFF = {
    pro: ['Let’s send it over to {L2}.', 'For more, we go to the {L2} studio.', 'Time to check in with {L2}.', 'Over to our friends at {L2}.', 'Let’s throw it across the hall to {L2}.', '{L2}, take it away.'],
    casual: ['Okay, back to the fancy folks at {L2}!', 'Let’s go bug {L2}.', 'Tossing it over to {L2}!', '{L2}, you’re up! Sit up straight.', 'Let’s see what the suits at {L2} are saying.', 'Over to {L2}. Be nice.'],
  };

  // ---------------------------------------------------------------- commercials
  // Fake ads for the commercial break. {A} a team (usually last place), {B} another team,
  // {L} league, {P} a player. [brand, tagline, body, fine print]
  const ADS = {
    pro: [
      ['Bench Regret™ Insurance', 'Because hindsight is 20/20.', 'Left 30 points on your bench? Bench Regret Insurance pays out in pure emotional damages. Just ask {A}.', 'Coverage excludes kickers, bye weeks and your own decisions.'],
      ['Waiver Wire Energy', 'Claim it before Wednesday.', 'The official drink of managers who refresh the waiver wire at 3 a.m. {A} drinks it by the case.', 'Not a substitute for actual research.'],
      ['{A} Financial Advisors', 'We know a thing about losses.', 'Down bad? Our advisors have lived it. Every week. Ask about our "Next Year" plan.', 'Past performance is, unfortunately, indicative of future results.'],
      ['Projection Pro™', 'Accurate 50% of the time, every time.', 'Projections so confident they forget the games are actually played. As trusted by {B}.', 'Projections are not promises. Ask {A}.'],
      ['The {L} Trophy Polish', 'For the shelf you’ll never use.', 'Keep your hardware gleaming. {B} uses it weekly. {A} uses it on hope.', 'Trophy sold separately. Talent sold separately.'],
      ['Trade Veto Hotline', 'Collusion? Call us.', 'Suspicious two-for-one? Our agents review every trade with the seriousness of a Super Bowl replay booth.', 'Hotline staffed by the commissioner’s cousin.'],
      ['Late Swing™ Antacid', 'For Sunday nights and Monday nights.', 'When your opponent has a Monday night QB and you have nothing left, reach for Late Swing.', 'May not prevent the {P} touchdown you’re dreading.'],
      ['Draft Day Do-Over', 'Pick again. In your dreams.', 'Wish you’d taken {P}? So does {A}. Our simulator lets you relive it. And relive it.', 'Does not affect actual standings.'],
      ['Primetime Couch Co.', 'Sit like a champion.', 'Ergonomic seating for three-game windows. As seen in the {B} living room.', 'Does not improve your lineup.'],
      ['Garbage Time Gold', 'Every point counts. Some count less.', 'Love a 4th-quarter backup touchdown in a 35-point game? So does your fantasy team.', 'Real NFL fans may disagree.'],
    ],
    casual: [
      ['Grandma’s Lineup Advice', 'She’s been right twice.', 'Can’t decide who to start? Call Grandma. She picks by jersey color. {A} should honestly try it.', 'Grandma is not liable for duds.'],
      ['Couch Potato Chips', 'Crunchy. Salty. Undefeated.', 'The only thing on the couch that never loses. Unlike {A}.', 'Contains 0% fantasy skill.'],
      ['Sorry About Your Team™ Cards', 'For every occasion. Mostly losses.', 'Send {A} a heartfelt card this week. Glitter optional.', 'Card cannot change the score.'],
      ['The Trash Talk Academy', 'Learn from the best (it’s {B}).', 'Ten easy lessons on how to text the group chat after a win. Lesson one: all caps.', 'Results may cause family tension.'],
      ['Dad’s Remote Finder', 'Because it’s always in the couch.', 'Never miss a {P} touchdown again. Beeps on command.', 'Batteries not included. Remote probably in the couch.'],
      ['Snack Bowl Insurance', 'For when someone eats all the dip.', 'Protect your snacks from that one cousin. You know who.', 'Does not cover {A}’s season.'],
      ['Participation Trophy Co.', 'Everybody’s a winner! (Not really.)', 'Custom trophies for {A}, celebrating "trying really hard". Engraving free.', 'Real trophy goes to {B}.'],
      ['Benchwarmer Blankets', 'Cozy enough for your bench guys.', 'Wrap up in the same comfort {P} enjoyed on {A}’s bench this week.', 'Warmth not guaranteed. Points definitely not.'],
      ['The Group Chat Mute Button', 'Peace and quiet, finally.', 'Lost by 40? Mute the group chat for 24 hours. {A} has it on speed dial.', 'Muting does not delete screenshots.'],
      ['Lucky Socks Laundry', 'We wash the luck right out.', 'Haven’t washed your lucky socks since week 1? Neither has {B}. We can help.', 'Luck not transferable.'],
    ],
  };
  const adOrder = { pro: [], casual: [] };
  function commercial(voice, vars) {
    const v = voice === 'casual' ? 'casual' : 'pro', pool = ADS[v];
    if (!adOrder[v].length) adOrder[v] = pool.map((_, i) => i).sort(() => Math.random() - 0.5);
    const [brand, tag, body, fine] = pool[adOrder[v].pop()].map((s) => fill(s, vars || {}));
    return { brand, tag, body, fine };
  }

  // ---------------------------------------------------------------- memory
  const DAY = new Date().toLocaleDateString('en-CA');
  const MEM_KEY = 'winProbDeskSaid';
  let mem;
  try { mem = JSON.parse(localStorage.getItem(MEM_KEY) || 'null'); } catch (e) { mem = null; }
  if (!mem || mem.day !== DAY) mem = { day: DAY, said: {} };
  const save = () => { try { localStorage.setItem(MEM_KEY, JSON.stringify(mem)); } catch (e) { /* ignore */ } };
  const recentCores = new Map(); // kind -> last few core indexes, so even a new combo rotates the news part

  function pickIndex(n, avoid) {
    const free = []; for (let i = 0; i < n; i++) if (!avoid.has(i)) free.push(i);
    const pool = free.length ? free : [...Array(n).keys()];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function fill(s, v) {
    return String(s).replace(/\{(\w+)\}/g, (_, k) => (v[k] != null && v[k] !== '' ? v[k] : ''));
  }

  // Returns { head, body, line } for an event, never repeating a full
  // opener+core+tag combination on the same day while unused ones remain.
  function write(kind, voice, vars) {
    const spec = CORES[kind];
    if (!spec) return null;
    const v = voice === 'casual' ? 'casual' : 'pro';
    const cores = spec[v], opens = OPEN[v][spec.mood], tags = TAG[v][spec.mood];
    const rc = recentCores.get(kind + v) || [];
    let best = null;
    for (let tries = 0; tries < 40; tries++) {
      const ci = pickIndex(cores.length, new Set(rc.slice(-Math.min(rc.length, cores.length - 1))));
      const oi = Math.floor(Math.random() * opens.length), ti = Math.floor(Math.random() * tags.length);
      const key = kind + '|' + v + '|' + ci + '|' + oi + '|' + ti;
      best = { ci, oi, ti, key };
      if (!mem.said[key]) break;
    }
    mem.said[best.key] = 1; save();
    rc.push(best.ci); recentCores.set(kind + v, rc.slice(-6));
    const [head, body] = cores[best.ci];
    const vv = Object.assign({}, vars);
    const open = fill(opens[best.oi], vv), tag = fill(tags[best.ti], vv);
    const b = fill(body, vv);
    return { head: fill(head, vv).toUpperCase(), body: b, line: open + ' ' + b + ' ' + tag };
  }

  function segmentTitle(seg, voice, vars) {
    const arr = (SEGMENTS[seg] || {})[voice === 'casual' ? 'casual' : 'pro'] || [seg];
    return fill(arr[Math.floor(Math.random() * arr.length)], vars || {});
  }
  function handoff(voice, vars) {
    const arr = HANDOFF[voice === 'casual' ? 'casual' : 'pro'];
    return fill(arr[Math.floor(Math.random() * arr.length)], vars || {});
  }
  function combos() {
    let n = 0;
    for (const k of Object.keys(CORES)) for (const v of ['pro', 'casual']) n += CORES[k][v].length * OPEN[v][CORES[k].mood].length * TAG[v][CORES[k].mood].length;
    return n;
  }

  window.DeskLines = { write, segmentTitle, handoff, commercial, combos, kinds: Object.keys(CORES) };
})();
