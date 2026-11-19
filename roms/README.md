# ROM folders

Place game files inside the matching system folder: atari2600, nes, gb, snes, gamegear, n64, or gbc. Supported ROM formats are .a26, .bin, .rom, .nes, .sfc, .smc, .gb, .gbc, .gg, .z64, .n64, .v64, and .zip. ZIPs are unpacked in the browser and matching ROMs are added to the local library.

manifest.json is the static-hosting file index. When adding a ROM or ZIP to the codebase, add its path and systemId there; static hosting does not expose a directory-listing API for new files to discover themselves. Existing manifest entries load directly and ZIP imports stay local to each visitor.
