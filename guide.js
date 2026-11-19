/* "Make your own game": 50 plain-language steps. Data only; the UI lives in app.js. */
(function (root) {
'use strict';
const Core = root.SnesCore || (typeof require !== 'undefined' ? require('./core.js') : null);
const S = (phase, title, why, prompt, action) => ({ phase, title, why, prompt, action: action || null });
const go = (tab, label) => ({ tab, label });
const P = ['Dream it', 'Pick your starting point', 'Build the art', 'Make it play', 'Test, polish and share'];
const list = [
// ---- 1. Dream it (1-10)
S(0, 'Describe your game in one sentence', 'A single sentence keeps every later decision honest. If you cannot say it simply, the game is not clear yet.', 'Finish this sentence: "My game is about a ___ who has to ___ in order to ___."'),
S(0, 'Pick a genre', 'Genre decides what code and art you need. A one-screen puzzle is far easier to finish than a scrolling adventure.', 'Which is closest: platformer, shooter, puzzle, racing, RPG, fighting, or something else? Why that one?'),
S(0, 'Say who it is for', 'Knowing your player tells you how hard and how long the game should be.', 'Who will play it (you, friends, kids, fans of a certain game)? How long should one play session last?'),
S(0, 'Name the one thing the player does most', 'Most good games are built around one action done in interesting ways: jump, shoot, match, drive.', 'What is the single action the player repeats the most? Describe how it should feel in your hands.'),
S(0, 'Describe the goal and how you lose', 'Players need to know what winning looks like and what it costs to fail.', 'How does the player win? How do they lose a life or fail? Is there a score, a timer, or a story ending?'),
S(0, 'List three games that inspire you', 'References give you something concrete to copy the feel of, and they are great for judging your own work.', 'Name three games and one thing you love about each. (Playing them in an emulator and capturing their assets is a good way to learn.)'),
S(0, 'Decide: change an existing game or make a new one', 'A mod keeps the original engine and changes art, text or levels. A new project means writing your own code. Mods are much faster.', 'Do you want to (a) modify a game you already have, or (b) start from an empty project? Write your choice and the reason.'),
S(0, 'Set your size limits', 'Small games get finished. Setting limits early stops the project from growing forever.', 'How many levels or screens, and how many different enemies? Write numbers you can actually finish in a few weeks.'),
S(0, 'Sketch the first screen on paper', 'A rough drawing shows problems long before you spend time on pixels.', 'Describe or draw your first screen: where is the player, the enemies, the goal, and the score?'),
S(0, 'Give it a working title', 'A title helps you talk about the game and becomes the name stored in the ROM header (21 letters at most).', 'Write a working title of 21 characters or fewer, capital letters and numbers work best.'),
// ---- 2. Starting point (11-20)
S(1, 'Understand the console you are making for', 'The SNES has fixed limits: a 256 by 224 picture, a limited number of colours per tile, and a small sound memory. Knowing this avoids surprises.', 'In your own words, write down which limits might matter most for your game (colours, sprites on screen, music size).', go('overview', 'Open Overview')),
S(1, 'Open a ROM you own, or start a new project', 'Either load a game you want to study or change, or begin with a clean starter ROM that already runs.', 'Which did you choose, and what is the file or project called?', go('open', 'Open ROM…')),
S(1, 'Start a new project if you are building from scratch', 'The starter project gives you a working screen, palette, tiles and a sprite you can change, so you never start from a blank page.', 'Pick a ROM size (smaller is fine, 128 KB is plenty for a first game) and a title. What did you choose?', go('new', 'New project…')),
S(1, 'Check what the studio knows about your ROM', 'The Game tab tells you the game, memory layout, checksum and any special chip. Special chips limit what can be edited.', 'What did the Game tab say about your ROM? Write anything that surprised you.', go('game', 'Open Game tab')),
S(1, 'Capture all assets from the ROM', 'Capturing pulls palettes, graphics sheets, sounds and text out into a folder you can browse, so you can see what the game is made of.', 'Which captured pictures or sounds would you like to reuse or change? List a few.', go('game', 'Capture assets')),
S(1, 'Learn the map of your ROM', 'The Overview map colours code, graphics, text and compressed data. It shows you where things live.', 'Where on the map do you see graphics-like areas? Write down one address to look at first.', go('overview', 'Open Overview')),
S(1, 'Understand memory layout: LoROM and HiROM', 'This decides how ROM addresses map to the file. The studio handles it for you, but it explains why addresses look like 0F:8D9F.', 'What mapping does your ROM use? (It is shown at the top of the window.)', go('game', 'See mapping')),
S(1, 'Make a safety copy before editing', 'You can undo inside the studio, but a saved copy of the original protects you from mistakes.', 'Where did you store the untouched original? Write the folder or file name.', go('export', 'Open Export')),
S(1, 'Decide which parts you will change first', 'Changing one thing at a time makes it easy to see what broke.', 'List the first three things you will change, in order (for example: player colours, enemy picture, title text).'),
S(1, 'Write your asset checklist', 'A list of every picture, sound and word you need turns a huge goal into small jobs.', 'List the art, sounds and text your game needs. Mark each one: reuse, change, or make new.'),
// ---- 3. Build the art (21-30)
S(2, 'Plan your colours', 'Each tile uses a small palette. Picking a few good colours makes a game look consistent.', 'Choose 4 to 8 main colours for your game. Describe them (for example: sky blue, grass green, dark outline).', go('pal', 'Open Palettes')),
S(2, 'Edit your first palette', 'Changing a palette recolours everything that uses it, instantly, with no new drawing.', 'Which palette did you change and what colours did you set? Does the screen look the way you wanted?', go('pal', 'Open Palettes')),
S(2, 'Find the graphics in your ROM', 'Tiles are 8 by 8 pixel squares. The Graphics tab lets you scroll through them and try different formats until the picture looks right.', 'At which address did you find tiles you recognise? Which bit depth (2, 3 or 4 bits) showed a clear picture?', go('gfx', 'Open Graphics')),
S(2, 'Draw or change the player character', 'The player is the thing people watch most. Spend your first art time here.', 'Describe your player: size, colours, and what makes them recognisable at a glance.', go('gfx', 'Edit tiles')),
S(2, 'Draw or change the enemies and obstacles', 'Enemies teach the player the rules. A different shape or colour for each kind makes the rules readable.', 'List each enemy or obstacle, and write what the player should learn from it.', go('gfx', 'Edit tiles')),
S(2, 'Make background tiles', 'A handful of background tiles can build a whole level when repeated. Aim for a few that join cleanly.', 'List your background tile types (ground, wall, sky, water…) and how they should join together.', go('gfx', 'Edit tiles')),
S(2, 'See your art put together', 'The Render tab draws real screens from the tiles, palettes and tilemaps, so you see the game, not just the data.', 'Does the render match what you imagined on paper? Write down anything to fix.', go('scene', 'Open Render')),
S(2, 'Import a picture from your own editor', 'You can draw in a normal image editor and bring it in. The studio matches your colours to the palette.', 'Which picture did you import, and how many colours did it need to be reduced to?', go('gfx', 'Import PNG')),
S(2, 'Write the words', 'Menu text, names and dialogue give your game a voice. Games store text in their own letter order, so check it carefully.', 'Write all the text your game needs: title, menu options, game over, and any story lines.', go('text', 'Open Text')),
S(2, 'Design the score, lives and other on-screen information', 'The heads-up display must be readable at a glance and must not hide the action.', 'What does the player need to see all the time (score, lives, health, time)? Where on the screen does each go?', go('scene', 'Open Render')),
// ---- 4. Make it play (31-40)
S(3, 'Look at the starter program', 'A tiny working program is the best teacher. The Code tab shows it as readable instructions.', 'Open the starter code. Write in your own words what the first few lines do.', go('code', 'Open Code')),
S(3, 'Understand how the program starts and loops', 'Every game sets up the screen once, then repeats a loop sixty times a second: read buttons, update things, draw.', 'In your game, what happens in setup, and what has to be checked every frame?', go('code', 'Open Code')),
S(3, 'Read the controller', 'Reading the buttons is the first step to anything interactive.', 'Which buttons will your game use, and what will each one do?', go('code', 'Open Code')),
S(3, 'Move the player', 'Movement is changing position a little each frame. Speed is just how much.', 'How fast should the player move? Does the player speed up, slow down, or move at one steady speed?', go('code', 'Open Code')),
S(3, 'Add gravity, jumping or other physics (if your game needs it)', 'Jumping is moving up then letting a downward pull win. Tuning this makes the game feel good or bad.', 'Describe the jump or movement feel. How high, how long, can the player change direction in the air?', go('code', 'Open Code')),
S(3, 'Add something that can hurt or help the player', 'Interaction between things is what makes it a game: touching an enemy, collecting an item.', 'What are the first two things the player can touch, and what happens for each?', go('code', 'Open Code')),
S(3, 'Add scoring and winning or losing', 'Without consequences there is no game. Keep the first version very simple.', 'Write the exact rule for a point gained, a life lost, a win and a game over.', go('code', 'Open Code')),
S(3, 'Add sound effects', 'Sound makes actions feel real. Short blips are enough for a first game.', 'Which three actions get a sound? Describe each (high, low, short, long).', go('audio', 'Open Audio')),
S(3, 'Add music', 'Music sets the mood. You can import a sound you have made and loop it.', 'Describe the mood of your music and how long a loop should be. Where will you get it?', go('audio', 'Open Audio')),
S(3, 'Connect the screens: title, game, game over', 'A complete game has a start, a middle and an end, and a way back to the start.', 'Draw the flow: title screen leads to what, then to what, and how does the player get back?', go('code', 'Open Code')),
// ---- 5. Test, polish, share (41-50)
S(4, 'Save the ROM and run it in an emulator', 'Testing on a real running game is the only way to know it works. An emulator is free and quick.', 'What emulator are you using? Did the game start? Write what you saw.', go('export', 'Save ROM')),
S(4, 'Write down what is broken', 'A list of problems is easier to fix than a vague feeling that something is wrong.', 'List every problem you noticed, from most to least important.'),
S(4, 'Fix one problem at a time and test again', 'Fixing many things at once hides which change helped. Undo is there if you go wrong.', 'Which problem did you fix first, and how did you check it was gone?', go('hex', 'Open Hex')),
S(4, 'Tune the difficulty', 'A game that is too easy is dull and too hard is frustrating. Small number changes can fix this.', 'What number could make it easier or harder (speed, enemy count, health)? What did you try?'),
S(4, 'Proofread every piece of text', 'Spelling mistakes are the first thing players notice.', 'Read all the text in the game aloud. Write down every correction.', go('text', 'Open Text')),
S(4, 'Check the ROM header', 'The header holds the title, region and checksum that emulators and flash carts read.', 'Is the title correct and 21 characters or fewer? What region did you pick?', go('export', 'Open Export')),
S(4, 'Fix the checksum', 'The checksum lets tools check the file is intact. The studio recalculates it when you save.', 'Did the studio report the checksum as valid after saving?', go('overview', 'See checksum')),
S(4, 'Make an IPS patch so you can share only your changes', 'A patch file holds only what you changed, so people who own the original game can apply it. This keeps you from sharing a full copy of someone else\'s game.', 'Who do you want to share the patch with, and where will you post it?', go('export', 'Export IPS')),
S(4, 'Ask three people to play it', 'Watching someone else play shows you problems you cannot see yourself.', 'Who played it? What confused them, and what made them smile?'),
S(4, 'Write release notes and plan the next version', 'Notes help people understand what they are playing, and a plan keeps you excited.', 'Write a short description of your game, how to play, and the three things you will improve next.')
];
const G = { PHASES: P, STEPS: list.map((s, i) => Object.assign({ n: i + 1 }, s)) };
G.brief = function (answers) { // plain-text design document from the user's answers
  let out = '# Game design notes\n\n';
  P.forEach((ph, pi) => {
    out += '## ' + (pi + 1) + '. ' + ph + '\n\n';
    for (const s of G.STEPS) if (s.phase === pi) { const a = (answers[s.n] || {}); out += '### Step ' + s.n + ': ' + s.title + (a.done ? ' ✓' : '') + '\n' + s.prompt + '\n\n' + (a.text ? a.text.trim() : '_(not answered yet)_') + '\n\n'; }
  });
  return out;
};
G.aiPrompt = function (step, answers) {
  const done = G.STEPS.filter((s) => s.n < step.n && answers[s.n] && answers[s.n].text && answers[s.n].text.trim()).map((s) => '- ' + s.title + ': ' + answers[s.n].text.trim().replace(/\s+/g, ' ').slice(0, 300));
  return 'I am making my own Super Nintendo style game with a ROM editing studio. I am on step ' + step.n + ' of 50: "' + step.title + '".\n\n' + (done.length ? 'What I have decided so far:\n' + done.join('\n') + '\n\n' : '') + 'This step asks: ' + step.prompt + '\n\nPlease help me answer it in plain language for a beginner, suggest two or three options, and tell me which you recommend and why. Keep it short.';
};
Core.Guide = G;
if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof window !== 'undefined' ? window : globalThis);
