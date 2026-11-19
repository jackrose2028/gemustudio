# SNES Studio (SNES + NES)
Browser-based SNES and NES ROM development studio. No install, no server, nothing uploaded.

Open `snes-studio-single-file.html` (or `index.html`) in Chrome/Edge/Firefox.

- Open ROM (.sfc, .smc with or without 512-byte copier header, .nes iNES;  drag & drop works) -> Overview asset map, header, vectors
- Hex, Graphics (1/2/3/4/8bpp, Mode 7 tile editor, PNG import/export), Palettes, Text, Code (65816 disassembler + assembler), Library
- New project: playable starter engine (source included) or blank
- Export: header editor, resize, checksum fix, Save .sfc, IPS patch export/apply, project .json
- Ctrl+Z / Ctrl+Y undo/redo. `node test.js` runs the core tests.

Use only ROMs you are entitled to use; share mods as IPS patches.

## NES support
- iNES / NES 2.0 (basic sizes) header parsing, mapper/mirroring/battery editing, PRG/CHR asset map
- CHR tiles as NES 2bpp planar, 64-colour master palette editing, palette finder
- 6502 disassembler and assembler (all 151 official opcodes), PRG bank selector for bank-switched mappers (approximate)
- NES starter game (playable) and blank project; Save .nes, IPS, project .json
- Not supported: unofficial opcodes, resizing PRG/CHR, FDS/UNIF, mapper-specific bank emulation.

## SMC
.smc files load with the copier header removed; Export > "Save as .smc" writes a 512-byte copier header back. Interleaved/split-dump copier formats are not handled.

Tests: `node test.js` (SNES core), `node nes_test.js` (NES core incl. 6502 simulation of the starter).

## Render, scrolling and audio
- **Render tab:** builds a picture of the scene from the ROM's own tiles, palettes, tilemap (SNES 32/64-wide BG maps with palette and flip bits; NES nametable + attribute table) and sprites (SNES OAM table or NES OAM, plus hand-listed sprites). It redraws live as you edit. "Use starter project layout" fills everything in for projects made here.
- **Graphics scrolling:** vertical slider over the whole ROM, mouse wheel (3 rows per notch), PageUp/PageDown/Arrow/Home/End keys, and a clickable strip showing every sub-palette.
- **Audio tab:** scans for SNES BRR samples, decodes to PCM, plays, shows the waveform, edits (gain, normalize, reverse, fade, resample, trim/delete a selection, loop block), exports WAV/.brr/raw or a zip of everything found, imports WAV/MP3/OGG/FLAC and re-encodes to BRR, and writes it back. NES DPCM (1-bit delta) and raw 8/16-bit PCM regions are supported too.
- Limits: music sequences, instrument tables and the SPC700 sample directory are game-specific and not parsed; if an edited sample grows or the loop point changes, the game's directory must be updated separately. The BRR scanner is heuristic.

Tests: `node audio_test.js` (BRR/DPCM/WAV codecs).


## Game support (300 titles)

The **Game** tab identifies the loaded ROM against 50 profiled titles (exact CRC32, then header title/checksum, then fuzzy name), shows measured facts (mapping, checksum, enhancement chip from the header), and offers a compressed-data explorer.

What was measured on real dumps (37 of the 50 games had a dump in the supplied set):
- Header title, mapping, size, cart type and checksum of every supplied ROM; 44 of 44 checksums validate (non-power-of-two sizes use the mirrored rule).
- ExHiROM (6 MB, header at $40FFC0) detected and mapped; checked on Dragon Quest III and Trials of Mana.
- Enhancement chips read from the header: SuperFX (Star Fox, Yoshi's Island), DSP (Mario Kart, Pilotwings), SA-1 (Super Mario RPG, Kirby Super Star), Cx4 (Mega Man X2).
- Super Mario World: LC_LZ2 pointer table (low $00B992, high $00B9C4, bank $00B9F6): all 50 streams decode; recompression round-trips and is smaller than the original.
- A Link to the Past: the little-endian LZ2 variant decodes 124 streams to exactly 0x600 bytes (statistical confirmation; pointer table not confirmed).

What is implemented from published descriptions but NOT confirmed against a game: LZ5 (Super Metroid, Mario Kart, SimCity) and HAL compression (Kirby Super Star). Scans find plausible candidates only.

Not included: decoders for Rare (DKC/KI), Square (Chrono Trigger, FF, Secret of Mana, SMRPG) and other proprietary formats; per-game level/enemy/item editors; code that runs on SuperFX, SA-1, Cx4 or DSP chips. The raw tools (hex, tiles, palettes, audio, text, 65816 code) work on all games.

Tests: `codec_test.js` (self-contained), `games_test.js` and `uitest4.py` (need the retail dumps placed in /tmp/roms; they are not shipped).

### Games 51-150
Profiles for games 51-150 were added. 76 of those 100 had a real dump in the supplied 325-ROM set: all 325 ROMs load, detect their mapping and pass the header checksum; every one of the 76 is identified by CRC32 (and by title when patched). The other 24 are identified by title only. Pilotwings 64 is a Nintendo 64 game and cannot load here. #84 (Aladdin) is the same game as #27. Games in this range have raw-tool support only (no per-game decoders); chips (Cx4 for Mega Man X2/X3, SA-1 for Kirby's Dream Land 3) are read from the header and flagged.
Tests: `games_test2.js` runs against the 325-ROM set in /tmp/roms_all.

### Games 151-300
Added. 42 of those 150 had a real dump in the supplied set (all identified by CRC32 and, when patched, by title); 108 are title-only; 4 are duplicates of earlier entries (#217, #223, #229, #261). Raw-tool support only. Overall: 155 profiles have measured data; 156 of the 325 supplied ROMs are matched exactly, and the remaining 169 load and work with the generic tools but are not profiled.

## Capture assets and the 50-step guide
- **Game tab > Capture assets** writes a .zip of palettes (JSON + swatch PNG), the largest graphics regions (raw + 2bpp/4bpp greyscale preview sheets), BRR sounds (.wav + .brr), readable text, header info and the first instructions at RESET. Super Mario World also gets its 50 compressed graphics decoded. `capture_audit.csv` is the result of running it on all 156 validated ROMs: 156/156 completed with no errors and every PNG/WAV structurally valid. Capture is heuristic: it finds candidates, and many games use compressed graphics, their own text encodings or compressed audio that it cannot read.
- **Make a Game tab** is a standalone 50-step guide (5 phases of 10) that works with no ROM loaded. Each step has a plain explanation, a prompt you answer, a button to the relevant tool, and a copyable prompt for an AI helper. Answers save in the browser and export as a Markdown design document.
Tests: `guide_test.js`; the audit used capture.js on /tmp/roms_all.

## 3D Rebuild
The **3D Rebuild** tab builds a new first-person 3D maze game (textured raycaster at 256x224, enemies, pickups, exit door, 1-5 levels, optional music) from the loaded ROM's own tiles, palettes and a BRR sound, and exports one self-contained .html you can play by double-clicking, or launch inside the studio. It does not convert the original game's logic and does not produce a .sfc/.nes. Art sources are raw ROM regions plus, for Super Mario World, its decompressed graphics (via the verified pointer table). Tile choice and palette are heuristics; the tab lets you change them. Tests: gen3d_test.js, uitest6.py.

### 2.5D side view (added to 3D Rebuild)
A second style, "2.5D side view": a scrolling platformer built from the ROM's art with layered parallax backgrounds (stars, glow clouds, skyline, ruins, blurred foreground), 3D-extruded blocks that change shape as you move past them, a player/enemy/pickup/exit taken from the ROM, jumping, stomping, shooting, pits, P/G bars, glow and scanlines (C toggles scanlines). The first-person maze is still there; pick the style in the tab. Works for SNES and NES ROMs. Auto-picked tiles are guesses; choose tiles and palette by hand for the best look.
