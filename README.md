# WORLDSEED

**Every name holds a world.**

Type any name — yours, your dog's, your company's — and watch a one-of-a-kind planet be born from it in real time. Claim it before anyone else does, and it becomes a permanent light in a living galaxy shared by everyone.

## What's inside

- **Deterministic world genome** — every name hashes to a unique DNA: archetype (garden, ocean, desert, frozen, molten, gas giant, barren, xeno), terrain, climate, rings, moons, civilisation, and rare phenomena (auroras, binary suns, orbital megastructures).
- **GPU planet renderer** (three.js + custom GLSL)
  - Terrain baked to a seamless cubemap on the GPU: domain-warped fBm continents, ridged mountains, Voronoi impact craters
  - Biomes from temperature/moisture/latitude, frozen seas, glowing lava fissures, coastline-hugging city lights on the night side
  - Raymarched Rayleigh + Mie atmospheric scattering with real sunsets and polar auroras
  - Animated clouds that cast shadows, banded gas giants with vortex storms, shadowed rings, eclipsing moons
  - A genesis sequence: accretion swirl → shockwave → molten crust cools → oceans fill → sky appears
- **The galaxy** — 130k-star spiral with dust lanes and nebulae. Every claimed world is a marker at its name's fixed coordinates.
- **Live** — Server-Sent Events push new discoveries, stars and online counts to everyone instantly.
- **Social** — rarity tiers with percentiles, shareable links with per-world meta tags, downloadable postcards, stars, a forge to reshape your world, photo mode, generative ambient audio.

## Run

```bash
npm install
npm start          # http://localhost:3000
```

Or with Docker: `docker compose up -d --build` (serves on port 8089, data in the `worldseed-data` volume).

Zero runtime dependencies besides three.js; the server is plain Node.

Keys in a world: `F` forge · `H` photo mode · `M` sound · `Esc` back.
