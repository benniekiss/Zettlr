Typst fonts are discovered from the operating system and the optional additional
font folder. No font files are bundled or downloaded at runtime. Document
appearance depends on the fonts installed on the machine; math requires a
suitable math font such as Cambria Math, STIX Two Math, or Latin Modern Math.

Font metadata is cached in memory for the current application session and
prepared in the background at startup. Early exports share that preparation;
failed preparation is retried on export. Each export rediscovers fonts and
checks file identity, size, and modification/change times before reusing
metadata. Font bytes are still loaded lazily by the compiler.

Webpack copies the pinned @myriaddreamin/typst.ts JavaScript compiler driver
and @myriaddreamin/typst-ts-web-compiler WASM package into this directory in the
application bundle. Both packages are Apache-2.0 licensed; the driver license
is copied alongside its code:
https://github.com/Myriad-Dreamin/typst.ts/tree/v0.7.0

The compiler is provided by typst.ts, not by pandoc.wasm or the Typst CLI.
