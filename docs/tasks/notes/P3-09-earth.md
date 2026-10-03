# P3-09 — Earth with its real continents

Branch `p3-09-earth`, from `p3-wave3-picking-lod` (93c90e9). Cosmin, after looking at the scene: "Planet Earth does not look like Earth. Can you change the object so it has the same continents as real Earth?"

## What was built

| File | What |
| --- | --- |
| `apps/web/scripts/earth-mask.mjs` | The generator, Node ≥ 18, no dependencies. It downloads (or reads, `--source <path>`) Natural Earth land polygons as GeoJSON, rasterises every ring with an even-odd scanline fill sampled at texel centres into an equirectangular grid (`--width`, default 1024 → 1024 × 512; row 0 = 90°N, column 0 = 180°W), and writes `earth-mask-data.ts`. The encoding is run lengths (sea first, alternating, row-major over the whole grid), each written as a base-64 varint (5 data bits per character, the 6th bit means "more follows"), split into 96-character lines that are already Prettier-clean. |
| `apps/web/src/scene/bodies/earth-mask-data.ts` | The generated mask: 9,865 encoded characters, an 11,079-byte module. The header records the source, date, size, land share and regeneration command. Do not edit by hand. |
| `apps/web/src/scene/bodies/earth-mask.ts` | `decodeMask` (validates characters and the total size), `earthMask()` (decoded once on the first Earth paint, about 20 ms, into a pyramid of land fractions: 1024, 512, 256, 128, 64, 32, each level averaging the one above), `maskLevelFor(width)` (the level whose texel matches a texture width: 2048 and 1024 → 0, 512 → 1, 256 → 2), `sampleLand(lat, lon, level)` (bilinear between texel centres, wraps in longitude, clamps at the poles), `uvToLatLon(u, v)`, and `EARTH_MASK_VERSION` = 1. |
| `bodies/appearance.ts` | `BodyLook.landMask?: 'earth'`, set on Earth only. |
| `bodies/surface.ts` | In the `earth` style, a look with `landMask` is painted by `earthTexel` (below). The procedural Earth-like painter is kept for any other `earth`-style look. The other styles are untouched. |
| `bodies/textures.ts` | `surfaceKey` appends `|mask:earth@<EARTH_MASK_VERSION>` for a masked look, so the far-map memo and the near-texture cache keys (`surfaceMapsKey`) change when the mask does. |

### How Earth is painted (`earthTexel`, per texel)

- **Land or sea.** The mask is sampled bilinearly at the pyramid level that matches the texture's size. At the far 256 map, each texel averages 4 × 4 mask texels, so there is no aliasing. Where the land fraction is between 0.02 and 0.98 (only along coasts), the land/sea threshold is pushed by fbm noise (0.5 ± 0.2), and the result is blended over a soft edge. This way the coasts aren't 1024-grid stairs at the 2048 level, and the far map isn't blocky. Open sea and inland texels skip the coastal noise.
- **Sea.** Deep blue far out, and lighter, shallow blue near coasts. Coast proximity comes from a coarse pyramid level, 256 wide, about 1.4° per texel. Seeded noise varies the depth tone.
- **Land.** Biomes by |latitude|, jittered by noise: rainforest near the equator, then savanna, grass, temperate forest, boreal forest, and tundra past about 66°. Then the deserts: a small table of 12 soft arid regions (Sahara, Arabia, Iran/Pakistan, Thar, Karakum, Taklamakan/Gobi, the Australian outback, Kalahari/Namib, Atacama, Patagonia, the North American deserts, the Horn of Africa). Their edges are warped by noise so none reads as an ellipse. A latitude-only rule would have made Florida, southern China and Brazil into sand. Seeded noise gives brighter and darker patches.
- **Ice.** Land south of about 62°S (Antarctica) and north of about 72°N (the Arctic islands), with a noisy edge. Greenland is everything north of 59°N and east of a line along Baffin Bay and the Davis Strait, so Baffin Island stays tundra. Earth's existing `polarCaps` (above about 75°, over land and sea) still adds Arctic sea ice. It also whitens the Ross and Ronne ice shelves, which Natural Earth's land layer leaves as sea.
- **Detail map** (levels with `detail`). Gloss (G) follows the mask: the ocean is `OCEAN_ROUGHNESS`, land is matte, ice is 0.7, and coasts blend between them. Relief (R) is flat (0.3) at sea, and noise only on land (halved on ice).

### Orientation

Equirectangular u = 0 is 180°W growing east, and v = 0 is the south pole (row 0 of a `DataTexture`, which is not flipped). On three's `SphereGeometry`, u = 0.5 (the prime meridian) faces local +X, 90°E faces −Z, and north is +Y. Seen from outside over Greenwich with north up, east is on the right, so the map is not mirrored. A test checks this against a real `SphereGeometry`. The spin (`rotation.y` increasing) is counter-clockwise seen from the north, so Earth turns eastward like the real one. The 23.44° tilt is unchanged.

## Data source and licence

- **Source:** Natural Earth, 1:50m physical vectors, "Land" (`ne_50m_land`), from the GitHub mirror `nvkelso/natural-earth-vector`: <https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson> (1.6 MB GeoJSON, not committed). Fetched and generated 2026-10-03.
- **Licence:** public domain. naturalearthdata.com: "All versions of Natural Earth raster + vector map data found on this website are in the public domain… No permission is needed to use Natural Earth. Crediting the authors is unnecessary."
- **Regenerate** (from the repo root): `node apps/web/scripts/earth-mask.mjs`. Optional flags are `--source <file-or-url>` (e.g. a local `ne_110m_land.geojson`), `--width <even>` and `--out <path>`. Re-running it against the same source gives byte-identical output, apart from the date line. When the data or sampling changes, bump `EARTH_MASK_VERSION`.
- **Why 1:50m at 1024:** measured module sizes were 110m at 720/1024/1440 = 6.3/9.2/13.5 kB, and 50m = 7.3/11.1/16.8 kB (gzip 4.6/7.0/10.7). 1024 is a 2× bilinear upsample at the 2048 near level, which the noisy coast hides, and 50m keeps small islands and fjords that 110m drops. Natural Earth's land layer leaves out lakes, ice shelves and very small islands. The Caspian is present (a hole in the land).

## Size

`vite build`, before (93c90e9) → after:

| chunk | before | after | delta |
| --- | --- | --- | --- |
| `SolarScene-*.js` (scene) | 1,076.90 kB (gzip 289.85) | 1,090.47 kB (gzip 299.23) | **+13.6 kB (gzip +9.4)** |
| `paint-worker-*.js` | 2.55 kB | 16.00 kB | +13.4 kB (the worker needs the mask too) |
| `index-*.js` (panel, first chunk) | 486.58 kB (gzip 143.01) | 486.58 kB (gzip 143.01) | 0 |

The panel chunk's hash changed only because it names the scene chunk's file. With the `SolarScene-<hash>.js` names normalised, before and after are byte-identical, so the panel has no mask and no three.js.

Paint cost (Vitest/Node, same machine, so relative): Earth 2048 + detail went from 4.9 s to 5.3 s (+10 %), 1024 from 1.20 s to 1.39 s, and the 256 far map from 81 ms to 95 ms (plus a one-time decode of about 20 ms). The extra comes from the coastal noise and the deserts' warp, which run only where needed, and from mask lookups. Scratch arrays are reused, so no texel allocates.

## Tests

`bodies/earth-mask.test.ts`, 30 tests, no WebGL:

- **Decoding:** full size, values 0/1, land share between 28 % and 38 % (33.0 %: the equirectangular grid over-counts Antarctica), pyramid widths and means, `maskLevelFor` per size, and run-length decoding plus its three errors (bad character, overflow, short).
- **Known places:** land at the Congo basin (0°, 20°E), Kansas (40°N, 100°W), the Australian outback, Germany, the Amazon, Siberia, the Sahara and India. Sea at the mid-Atlantic (0°, 30°W), the central Pacific, the Indian Ocean, the North Pacific and the South Atlantic. Land under the ice at Antarctica (80°S) and Greenland (72°N, 40°W). Not mirrored: West Africa and Venezuela are land with the Atlantic between them, and the Gulf of Guinea is sea. Longitude wrap at the date line, and the poles.
- **Orientation:** `uvToLatLon`, and three's `SphereGeometry`: the prime meridian is on +X, 90°E on −Z (the viewer's right), and 45°N up.
- **Painter output:** at every texture size a tier uses up to 1024 (256 far, 512 mobile, 1024 mid; 2048 uses the same mask level as 1024), the known points paint as land colours, sea colours, or ice (white), and the Sahara is sand. In the detail map, sea points are glossy and flat and land points are matte. Output is deterministic, the colour map equals `paintSurface`'s, and `paintAsync` gives the same pixels through the main-thread fallback (the worker runs the same `paintSurfaceLayers`).
- **Cache key:** carries `mask:earth@1`. A look without the mask gets a different key, and Mars's key has no mask part.
- **Other bodies unchanged:** FNV hashes of the 64 × 32 colour and detail maps of every other planet, moon and the default look were recorded before the change, and they still match.

Gates from the repo root: `pnpm build`, `pnpm typecheck`, `pnpm lint` and `pnpm format:check` are green. In `pnpm test`, protocol passes 67/67 and web passes 447/447 (47 files). The server passes 842 + 1 skipped of 843. The exception is one Waykeeper test that does a lot of git work (`waykeeper.test.ts`, "sends the Steward back to resolve a conflict…"). It timed out at 5 s in two full runs while the machine's load average was about 20 from other agents. It passes alone, and the whole server suite passes with `--testTimeout=20000`. This branch changes no server code.

## Screenshots (headless Chrome, not committed)

Method: a throwaway page, deleted afterwards. It seeded the store with the catalogue parsed from migration 0005, mounted the real `SolarScene`, and called `useCameraStore.flyTo('b-earth')`. It was driven by Chrome 154 headless over CDP (ANGLE Metal), 1200 × 800, on Vite port 5747.

- **Before (high tier, reduced motion):** a made-up planet. Blobby green-and-tan noise continents in a bright mid-blue ocean, and a polar cap. Nothing resembles Earth.
- **After (high tier, reduced motion, same camera):** the Americas face the camera. North America has the Gulf of Mexico, Florida, the Caribbean islands, Central America and the sandy US southwest/Mexico. South America sits to the lower right, with the green Amazon and a thin pale Atacama strip down the west coast. Greenland is white at the top, and the Sun's glint is on the Pacific. North is up, and the continents are not mirrored.
- **After (high tier, with motion, about 25 s later):** Earth has turned eastward. It shows Europe, the Mediterranean, the pale Sahara and Arabia, the Red Sea and Persian Gulf, India and the Indian Ocean, and green central Africa to the south-west, with the Moon passing in front.
- **After (mobile tier, 512 map, no detail):** the same Americas view, slightly softer, with the coasts still clean.

## Deferred

- **Clouds** (a transparent sphere slightly above the surface, off on mobile). Not done. It needs its own painted texture, a second sphere and alpha blending per Earth, and a decision on whether it rotates. It's cheap, but it isn't needed for "recognisable continents". Make it a follow-up if Cosmin wants it.
- Real elevation (mountain shading on the Himalaya and Andes) and snow on high ground: the relief on land is noise.
- Ice shelves (Ross, Ronne) come out as sea under the polar cap overlay, which is white anyway.

## What Cosmin should check

1. `pnpm dev`, then fly to Earth (breadcrumb or `]`) on **high**. The continents should be recognisable at once on the 256 far map, and sharpen after about 1–2 s on the 2048 + detail map. The oceans should have the sun glint, and the land should not.
2. On the settings page, switch to **mobile** and look at Earth again: 512 map, no detail.
3. Say if the desert tones or the ocean blue should be adjusted. The colours are the `EARTH` table at the top of the masked-painter section in `surface.ts`.
