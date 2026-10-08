// Per-layer explanatory content for the Geo GIS Explorer's legend ⓘ button, plus the overlay panel
// that renders it.
//
// The explorer can show a couple of dozen scientific fields, and a colorbar alone does not tell you
// what a number MEANS — whether 8 is alarming or ordinary, whether a red map is an event or a
// baseline artifact, or which other layer would explain the pattern. Each entry answers the same
// five questions in the same order, so switching layers teaches by comparison:
//
//   what      — the physical quantity, and how it was measured or modeled
//   scale     — what this layer's value range means, including any operational thresholds
//   overTime  — what CHANGE means: the seasonal cycle, and what the time-lapse is good for
//   trends    — the long-term signal, and honestly whether THIS record can show it
//   correlates— other layers that explain or co-vary with it (rendered as clickable chips)
//
// Content rules: name thresholds where the science defines them (coral bleaching at 4 / 8 °C-weeks,
// the 15 % ice edge, the 26.5 °C cyclone threshold) — they are what turn a color into a judgement.
// Be explicit where a feed's sampling undercuts a reading (12:00Z snapshots of a diurnal field, an
// instantaneous rate standing in for a monthly total) rather than letting the map imply more than
// the data supports.

/**
 * Where a layer's numbers come from. Every layer carries one: a value with no traceable provenance
 * cannot be checked, cited or reproduced, and this map is easy to screenshot into contexts where the
 * source no longer travels with it. `access` names the path the bytes actually took, which is not
 * always the producer — several products reach the browser through a different agency's ERDDAP.
 */
export interface Citation {
  /** Product name as its producer publishes it. */
  product: string;
  /** Producing agency / programme. */
  provider: string;
  /** How this build actually obtains it (host, dataset id, or "baked" for a committed atlas). */
  access: string;
  /** Landing page for the product. */
  url: string;
  /** Attribution or licence obligation, when the source carries one. */
  license?: string;
}

/** One layer's explanatory copy. `key` order in LAYER_INFO is irrelevant; lookup is by layer key. */
export interface LayerInfo {
  /** Provenance — required, so no layer can quietly ship without a source. */
  cite: Citation;
  /** The physical quantity and its provenance (measured vs modeled). */
  what: string;
  /** What the value range means — thresholds, what the floor and ceiling represent. */
  scale: string;
  /** What change over time means; the seasonal cycle; what the time-lapse reveals. */
  overTime?: string;
  /** Long-term trend, and whether this record is long enough to show it. */
  trends?: string;
  /** Layers that co-vary, each with the physical reason. `key` must be a real layer key. */
  correlates?: Array<{ key: string; why: string }>;
}

export const LAYER_INFO: Record<string, LayerInfo> = {
  // ── Ocean ────────────────────────────────────────────────────────────────────────────
  sst: {
    cite: { product: 'OISST v2.1 (Optimum Interpolation SST)', provider: 'NOAA NCEI', access: 'live NCEI ERDDAP (ncdc_oisst_v2_avhrr…) + committed baked stack', url: 'https://www.ncei.noaa.gov/products/optimum-interpolation-sst' },
    what: 'Temperature of the topmost meter or so of the ocean, from NOAA\'s OISST analysis — infrared '
      + 'satellite retrievals blended with ship, drifting-buoy and Argo-float measurements onto a daily '
      + '0.25° grid. Land and ice-covered cells carry no value.',
    scale: '−2 °C is seawater at its freezing point, found under ice. 28–30 °C is the tropical warm pool. '
      + 'The number to know is 26.5 °C: tropical cyclones generally need at least that much warmth in the '
      + 'upper ocean to intensify, so the edge of the warm region is also the edge of hurricane country.',
    overTime: 'Outside the tropics the seasonal swing dominates everything else — mid-latitudes move '
      + '10–15 °C between winter and summer while the deep tropics barely move two or three. Scrub a full '
      + 'year and you watch the whole thermal pattern breathe north and south with the sun.',
    trends: 'Global mean sea-surface temperature has risen roughly 0.1–0.2 °C per decade since 1980, and '
      + 'the ocean has taken up the large majority of the excess heat in the climate system. You will not '
      + 'SEE that in this layer, though: the seasonal cycle is an order of magnitude larger than the trend. '
      + 'Switch to SST anomaly, or use the Δ-vs-prior-year view, to make the trend legible.',
    correlates: [
      { key: 'anom', why: 'the same field with the seasonal cycle and latitude gradient removed' },
      { key: 'dhw', why: 'heat stress accumulates wherever SST runs above the local summer normal' },
      { key: 'ice', why: 'ice forms and survives only where SST sits at the freezing point' },
      { key: 'chl', why: 'warm water stratifies, cutting off the nutrient supply from below' },
      { key: 'airtemp', why: 'over the ocean the surface sets the air temperature above it' },
    ],
  },
  anom: {
    cite: { product: 'OISST v2.1 (Optimum Interpolation SST)', provider: 'NOAA NCEI', access: 'live NCEI ERDDAP (ncdc_oisst_v2_avhrr…) + committed baked stack', url: 'https://www.ncei.noaa.gov/products/optimum-interpolation-sst' },
    what: 'Sea-surface temperature minus the 1971–2000 average for that same place and day of year. '
      + 'Subtracting the climatology removes both the seasonal cycle and the equator-to-pole gradient, so '
      + 'what remains is purely "unusual for here, now".',
    scale: 'Diverging around zero: blue is cooler than normal, red warmer. ±0.5 °C is unremarkable, ±2 °C '
      + 'is a strong regional event, and ±3–5 °C is extreme — usually shallow seas, a stalled upwelling, or '
      + 'a marine heatwave.',
    overTime: 'This is the layer where climate signals become visible. El Niño appears as a warm tongue '
      + 'spreading along the equatorial Pacific and persisting for seasons; La Niña as its cool mirror '
      + 'image. Marine heatwaves show up as warm blobs that sit in place for months.',
    trends: 'Because the baseline is 1971–2000, recent years read warm almost everywhere — a map that is '
      + 'mostly red is showing you the warming trend, not a single event. A useful exercise: scrub from 2016 '
      + 'to now and watch how much of the ocean\'s area stays above zero.',
    correlates: [
      { key: 'sst', why: 'the absolute field this is measured against' },
      { key: 'mhw', why: 'heatwave categories are defined from where the local distribution\'s warm tail sits' },
      { key: 'dhw', why: 'sustained positive anomaly in summer is what accumulates into coral heat stress' },
      { key: 'precip', why: 'ENSO\'s Pacific anomaly pattern reorganizes tropical rainfall worldwide' },
    ],
  },
  ice: {
    cite: { product: 'OISST v2.1 (Optimum Interpolation SST)', provider: 'NOAA NCEI', access: 'live NCEI ERDDAP (ncdc_oisst_v2_avhrr…) + committed baked stack', url: 'https://www.ncei.noaa.gov/products/optimum-interpolation-sst' },
    what: 'The fraction of each grid cell covered by sea ice, from passive-microwave satellite retrievals '
      + 'carried inside the OISST analysis. This is concentration, not thickness — a cell can be 100 % '
      + 'covered by ice a few centimeters thick or by multi-year ice several meters thick.',
    scale: '0 % is open water, 100 % is fully covered. The threshold that matters operationally is 15 %: '
      + 'that is the contour conventionally used to define the "ice edge" and to compute the sea-ice extent '
      + 'figures that get reported each year. Above about 90 % is consolidated pack ice.',
    overTime: 'A powerful annual cycle running opposite in the two hemispheres — the Arctic bottoms out in '
      + 'September and peaks in March, the Antarctic the reverse. Play a multi-year loop and the two poles '
      + 'pulse in antiphase.',
    trends: 'Arctic September extent has declined on the order of 13 % per decade since satellite records '
      + 'began in 1979, which is among the clearest trends in the whole climate system. Antarctic sea ice '
      + 'behaved differently — roughly flat or slightly growing until the mid-2010s, then dropping to record '
      + 'lows. Set a September date and use the min-over-years view to compare summers.',
    correlates: [
      { key: 'sst', why: 'the −1.8 °C freezing line is effectively the ice boundary' },
      { key: 'swup', why: 'ice reflects sunlight that open water would absorb — the ice-albedo feedback' },
      { key: 'airtemp', why: 'ice loss and Arctic amplification reinforce each other' },
    ],
  },
  chl: {
    cite: { product: 'S-NPP VIIRS chlorophyll-a', provider: 'NOAA CoastWatch', access: 'committed baked atlas — the host sends no CORS header, so it is prepared offline by tools/geo/', url: 'https://coastwatch.noaa.gov/' },
    what: 'Chlorophyll-a concentration from ocean-color satellites, in mg/m³ — a proxy for how much '
      + 'phytoplankton is in the water, which is the base of the entire marine food web and a major term in '
      + 'the ocean\'s carbon uptake.',
    scale: 'This bar is logarithmic: each step multiplies rather than adds. 0.02 is the clearest water in '
      + 'the subtropical gyres, biologically almost a desert; 0.1–0.3 is ordinary open ocean; 1–20 is a '
      + 'coastal or upwelling bloom. The range from bottom to top is a factor of a thousand.',
    overTime: 'Spring blooms fire in both hemispheres\' mid-latitudes as light returns and the water column '
      + 'restratifies. Upwelling blooms along eastern ocean margins pulse with the wind that drives them.',
    trends: 'The five subtropical gyres are the ocean\'s low-productivity deserts and there is evidence they '
      + 'have been expanding, but ocean-color trends are genuinely contested — they are sensitive to sensor '
      + 'calibration and to stitching successive satellite missions together. The baked record here is far '
      + 'too short to settle anything; read it for pattern, not for trend.',
    correlates: [
      { key: 'sst', why: 'warm stratified water starves the surface of nutrients — warm usually means barren' },
      { key: 'precip', why: 'river plumes deliver nutrient and sediment to coastal water' },
      { key: 'mhw', why: 'marine heatwaves suppress productivity where they persist' },
    ],
  },

  // ── Coral & heat stress ──────────────────────────────────────────────────────────────
  dhw: {
    cite: { product: 'Coral Reef Watch 5 km daily', provider: 'NOAA Coral Reef Watch', access: 'live PacIOOS ERDDAP (dhw_5km)', url: 'https://coralreefwatch.noaa.gov/' },
    what: 'Degree Heating Weeks: accumulated thermal stress on coral. NOAA Coral Reef Watch sums, over a '
      + 'rolling 12-week window, how far each day\'s sea-surface temperature exceeded the warmest month\'s '
      + 'normal temperature for that exact location. Units are °C-weeks — one week at 1 °C above normal, or '
      + 'half a week at 2 °C above, each contribute 1.',
    scale: 'Zero means nothing has accumulated. The operational thresholds are the whole point of the '
      + 'layer: at 4 °C-weeks significant coral bleaching becomes likely, and at 8 °C-weeks severe '
      + 'bleaching with widespread mortality becomes likely. This scale tops out at 16 — twice the mortality '
      + 'threshold — and anything higher is clamped to the top color.',
    overTime: 'Stress builds through the local summer and decays afterwards, so a reef\'s fate depends both '
      + 'on how high the peak got and how long it stayed there. Basin-wide peaks line up with the major '
      + 'global bleaching events (1998, 2010, 2016, and 2023–24). Pick a reef region and scrub: 2016 for the '
      + 'Great Barrier Reef, 2023–24 for Florida and the Caribbean.',
    trends: 'The record here starts in 1985 upstream, and the clearest signal in it is that the interval '
      + 'between severe bleaching events has been shrinking. A badly bleached reef needs a decade or more to '
      + 'recover; in many regions events now return faster than that, which is why repeat frequency matters '
      + 'as much as any single peak.',
    correlates: [
      { key: 'baa', why: 'the alert level is derived directly from this plus the current hotspot' },
      { key: 'anom', why: 'anomaly is the raw departure; this is its accumulation above a coral-relevant threshold' },
      { key: 'sst', why: 'the absolute temperature the accumulation is computed from' },
      { key: 'mhw', why: 'a different accumulation of the same warmth, defined for ecosystems generally' },
    ],
  },
  baa: {
    cite: { product: 'Coral Reef Watch 5 km daily', provider: 'NOAA Coral Reef Watch', access: 'live PacIOOS ERDDAP (dhw_5km)', url: 'https://coralreefwatch.noaa.gov/' },
    what: 'The Bleaching Alert Area — Coral Reef Watch\'s operational alert level, combining how hot the '
      + 'water is right now with how much stress has already accumulated. This is the product reef managers '
      + 'actually act on.',
    scale: 'An ORDINAL ladder, not a measurement: 0 no stress · 1 watch (at or above the warmest monthly '
      + 'normal) · 2 warning (1 °C above it, stress starting to accumulate) · 3 alert level 1 (≥4 °C-weeks, '
      + 'bleaching likely) · 4 alert level 2 (≥8 °C-weeks, severe bleaching and mortality likely). Because '
      + 'the steps are categories, a 4 is not "twice as bad" as a 2, and averaging them is arithmetic on '
      + 'labels — read them as severity classes.',
    overTime: 'The max-over-years view is the natural one here: it maps the worst alert level a reef has '
      + 'ever reached over everything you have loaded.',
    correlates: [
      { key: 'dhw', why: 'the accumulated stress this ladder is built from' },
      { key: 'sst', why: 'the instantaneous hotspot half of the definition' },
    ],
  },
  mhw: {
    cite: { product: 'Coral Reef Watch 5 km marine heatwave', provider: 'NOAA Coral Reef Watch', access: 'live PacIOOS ERDDAP (mhw_5km)', url: 'https://coralreefwatch.noaa.gov/product/marine_heatwave/' },
    what: 'Marine heatwave category. A marine heatwave is defined (following Hobday and colleagues) as sea '
      + 'temperature above the local 90th-percentile climatology for at least five consecutive days; the '
      + 'category then counts how many multiples of that threshold-above-average distance are being '
      + 'exceeded. Unlike coral heat stress, this definition is about the ecosystem generally, not reefs.',
    scale: 'Ordinal: 0 none · 1 moderate · 2 strong · 3 severe · 4 extreme · 5 beyond extreme. The '
      + 'thresholds are relative to each location\'s own distribution, so a category 2 in the Gulf of Maine '
      + 'and one in the Coral Sea are equally unusual for their own place — not equally warm.',
    overTime: 'Upstream coverage begins only in July 2024, so this layer shows the current era rather than '
      + 'history. Its best use is the global question: how much of the world ocean is in a heatwave today, '
      + 'and where.',
    trends: 'Marine heatwave days per year have roughly doubled globally since the early twentieth century, '
      + 'and both intensity and duration have increased. That comes from far longer reconstructions — the '
      + 'record available here is nowhere near long enough to show it.',
    correlates: [
      { key: 'anom', why: 'the temperature departure the category thresholds are applied to' },
      { key: 'dhw', why: 'the coral-specific counterpart, thresholded on the warmest month instead of a percentile' },
      { key: 'chl', why: 'persistent heatwaves suppress productivity and reorganize fisheries' },
    ],
  },

  // ── Waves ────────────────────────────────────────────────────────────────────────────
  waves: {
    cite: { product: 'WaveWatch III global wave model', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ww3_global)', url: 'https://polar.ncep.noaa.gov/waves/' },
    what: 'Significant wave height from NOAA\'s WaveWatch III model — the mean height of the highest third '
      + 'of the waves present, which is close to what an experienced observer would call "the wave height". '
      + 'This is model output driven by forecast winds, not a measurement, and it has no coverage poleward '
      + 'of about ±77°.',
    scale: 'Under 1 m is a calm sea; 2–4 m is an ordinary open-ocean sea state; over 8 m is a severe storm. '
      + 'Remember that significant height is a statistic — the largest individual crests in a given sea run '
      + 'close to double it, which is why 8 m on this map is genuinely dangerous.',
    overTime: 'A strong seasonal seesaw between the hemispheres: the North Atlantic and North Pacific peak '
      + 'in boreal winter, while the Southern Ocean stays the most energetic water on the planet all year. '
      + 'Individual storms read as high patches sweeping east along the storm tracks.',
    trends: 'Mean and extreme wave heights have increased in the Southern Ocean over recent decades; '
      + 'elsewhere the regional signals are mixed and sensitive to which wind reanalysis drives the model.',
    correlates: [
      { key: 'swell', why: 'the far-traveled component, usually the larger share of this total' },
      { key: 'windsea', why: 'the locally wind-driven component that makes up the rest' },
      { key: 'pressure', why: 'deep lows are where the wind that raises these seas lives' },
      { key: 'period', why: 'height and period together set wave power and coastal impact' },
    ],
  },
  swell: {
    cite: { product: 'WaveWatch III global wave model', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ww3_global)', url: 'https://polar.ncep.noaa.gov/waves/' },
    what: 'The swell portion of the sea state: waves generated by distant storms that have since propagated '
      + 'away from where they were made, now travelling on their own and no longer forced by the local wind.',
    scale: '0–8 m. Over most of the ocean most of the time, swell — not local wind — is the larger part of '
      + 'the total wave height.',
    overTime: 'Swell radiates outward from the storm belts and crosses entire ocean basins over days, which '
      + 'you can watch frame to frame. The instructive comparison is against wind-sea: large swell under '
      + 'light local wind means there is a storm somewhere upwind, often thousands of kilometers away and '
      + 'days in the past. Southern Ocean swell regularly reaches North Pacific coastlines.',
    correlates: [
      { key: 'windsea', why: 'its complement — the two together separate "storm here" from "storm elsewhere"' },
      { key: 'period', why: 'swell is the long-period energy; dispersion sorts the longest periods to arrive first' },
      { key: 'waves', why: 'the total sea state this feeds' },
    ],
  },
  windsea: {
    cite: { product: 'WaveWatch III global wave model', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ww3_global)', url: 'https://polar.ncep.noaa.gov/waves/' },
    what: 'The wind-sea portion of the sea state: the short, steep waves still actively being forced by the '
      + 'wind blowing over them right now.',
    scale: '0–8 m. High wind-sea is a statement about the wind at that spot at that moment, not about '
      + 'anything that happened elsewhere.',
    overTime: 'Wind-sea tracks the wind field almost immediately, whereas swell lags it and then travels. '
      + 'Turning on the wind overlay while this layer is up makes the coupling obvious — the arrows and the '
      + 'color move together, which they do not do for swell.',
    correlates: [
      { key: 'swell', why: 'the far-field complement to this local response' },
      { key: 'pressure', why: 'the pressure gradient is what drives the wind that raises wind-sea' },
      { key: 'waves', why: 'the total sea state this feeds' },
    ],
  },
  period: {
    cite: { product: 'WaveWatch III global wave model', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ww3_global)', url: 'https://polar.ncep.noaa.gov/waves/' },
    what: 'Peak wave period — the time between crests at the most energetic frequency in the wave spectrum, '
      + 'in seconds. Where height says how big, period says what kind.',
    scale: '4–8 s is local wind chop. 10–14 s is a moderate swell. 15–20 s is long groundswell that has '
      + 'traveled a very long way from a powerful storm. Period is the best single clue to how far the '
      + 'energy has come, because wave dispersion sorts the fastest, longest waves to the front.',
    overTime: 'Watch a storm form and then watch long periods arrive at a distant coast a few days later, '
      + 'ahead of the height. Wave power scales roughly with height squared times period, so period matters '
      + 'as much as height for coastal impact, harbour resonance and wave-energy resource.',
    correlates: [
      { key: 'swell', why: 'long periods are the signature of swell rather than local sea' },
      { key: 'windsea', why: 'short periods with big height means the storm is on top of you' },
    ],
  },

  // ── Atmosphere ───────────────────────────────────────────────────────────────────────
  rain: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'Instantaneous surface precipitation rate from the GFS forecast model, sampled at the 12:00 UTC '
      + 'analysis. This is a model field, not a measurement, and it is a rate at one instant rather than an '
      + 'accumulation over any period.',
    scale: 'Logarithmic, and sparse — cells at the bottom of the scale mean "not raining here" and are drawn '
      + 'as the basemap rather than as a color, so only actual precipitation is painted. Roughly: 0.5 mm/h '
      + 'is light, 2–10 mm/h moderate to heavy, above 25 mm/h torrential.',
    overTime: 'Treat the time-lapse carefully. A 12:00Z snapshot of an instantaneous rate is a very thin '
      + 'sample of an extremely intermittent field: one monthly frame answers "was it raining at noon UTC on '
      + 'the 1st", not "how wet was that month". For anything climatological, use the daily-rainfall layer, '
      + 'which is an accumulation and has a forty-year record.',
    correlates: [
      { key: 'precip', why: 'the observational, accumulated counterpart — and the one with a long record' },
      { key: 'humidity', why: 'rain needs moisture; the moist tongues arrive before the rain does' },
      { key: 'lwup', why: 'deep convection lifts cold cloud tops over a warm surface' },
      { key: 'pressure', why: 'frontal rain organizes along the lows and their trailing bands' },
    ],
  },
  precip: {
    cite: { product: 'PERSIANN-CDR precipitation Climate Data Record', provider: 'NOAA NCEI / UC Irvine CHRS', access: 'live NCEI ERDDAP (cdr_persiann…)', url: 'https://www.ncei.noaa.gov/products/climate-data-records/precipitation-persiann' },
    what: 'Daily precipitation total from PERSIANN-CDR: a neural-network retrieval that turns geostationary '
      + 'infrared cloud-top brightness into rainfall, bias-corrected against rain gauges, on a 0.25° grid '
      + 'running from 1983 to the present. Coverage is limited to ±60° latitude, which is why the map cuts '
      + 'off in a straight line.',
    scale: 'Logarithmic millimeters per day, and sparse — dry cells show the basemap. 1–5 mm/day is light, '
      + '10–25 mm/day heavy, and above 50 mm/day is an extreme daily total for most places. The top of the '
      + 'scale is 100 mm/day; tropical extremes exceed it and clamp.',
    overTime: 'This is the only precipitation layer here with a climate-length record, so it is the one to '
      + 'use for questions about change. Monsoon onset and withdrawal, the seasonal migration of the '
      + 'intertropical convergence zone, and multi-year drought are all legible. The classic exercise is '
      + 'ENSO\'s rainfall teleconnection: in El Niño years convection shifts east along the equatorial '
      + 'Pacific, drying Indonesia and eastern Australia while soaking coastal Peru and Ecuador, and La Niña '
      + 'reverses it. Compare 2015–16 against a neighboring year with the Δ view.',
    trends: 'The broad expectation, and largely the observation, is that wet regions have grown wetter and '
      + 'dry ones drier, and that extreme daily totals have intensified — warmer air holds about 7 % more '
      + 'moisture per °C, which loads the heaviest events first. Satellite retrievals carry their own '
      + 'instrument drifts across missions, so treat decade-scale trends from this layer as indicative.',
    correlates: [
      { key: 'rain', why: 'the model rate, useful for structure at an instant rather than totals' },
      { key: 'anom', why: 'tropical Pacific temperature anomalies reorganize rainfall globally' },
      { key: 'humidity', why: 'the moisture supply that rainfall draws down' },
    ],
  },
  airtemp: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'GFS air temperature two meters above the surface — the "screen temperature" a weather station '
      + 'reports and the number you would call today\'s temperature. Covers land and ocean alike.',
    scale: 'Roughly −40 to 45 °C. Toggle °F/°C in the gear menu if you prefer.',
    overTime: 'The largest seasonal signal of any layer here, and the contrast is instructive: continental '
      + 'interiors swing enormously while ocean and coasts barely move, because water has vastly more '
      + 'thermal inertia. One caveat to keep in mind — every frame is a 12:00 UTC snapshot, so local solar '
      + 'time varies with longitude. At any instant one side of the map is at local noon and the other is at '
      + 'midnight, and the map mixes day and night temperatures accordingly.',
    trends: 'The record available here begins in December 2022 — far too short to say anything about trend. '
      + 'For that, use SST anomaly, which has both a long baseline and the seasonal cycle already removed.',
    correlates: [
      { key: 'skintemp', why: 'the surface underneath; the DIFFERENCE between them is the interesting part' },
      { key: 'sst', why: 'over the ocean, the water sets the air temperature above it' },
      { key: 'humidity', why: 'relative humidity is measured against this temperature, so the two move together' },
      { key: 'solar', why: 'the energy input that drives the diurnal and seasonal cycle' },
    ],
  },
  skintemp: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'The temperature of the actual surface — soil, rock, canopy or water — rather than of the air '
      + 'above it. Over the ocean this is essentially sea-surface temperature; over land it can differ from '
      + 'the two-meter air temperature by tens of degrees.',
    scale: 'Roughly −40 to 55 °C. Bare desert at local noon exceeds the top of this scale — dry sand can '
      + 'pass 70 °C — and clamps to the hottest color.',
    overTime: 'Swings far harder than air temperature, both daily and seasonally, because the surface has '
      + 'little thermal mass and responds directly to sunlight rather than through the air. Which makes the '
      + 'SAMPLING HOUR the first thing to check here: each daily frame is a single 12:00 UTC instant unless '
      + 'you switch the gear menu\'s sampling to a daily max/min/mean. 12:00 UTC is 06:00 in New Mexico and '
      + '21:00 in Japan, so on the snapshot a global map is comparing dawn against night — one high-desert '
      + 'cell reads 14 °C at 12 UTC and 46 °C at local noon the same day. The reductions read every 3-hourly '
      + 'step, which is coherent worldwide because every longitude passes local noon once per UTC day.',
    trends: 'Same caveat as air temperature: the record here starts in December 2022, which is a weather '
      + 'record, not a climate one.',
    correlates: [
      { key: 'airtemp', why: 'compare the two: where the surface runs far hotter, it is dry and bare; where they '
        + 'converge, evaporation from vegetation or water is doing the cooling' },
      { key: 'lwup', why: 'surface emission is almost exactly σT⁴ of this temperature' },
      { key: 'solar', why: 'the sunlight being absorbed and re-emitted' },
    ],
  },
  humidity: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'Relative humidity at two meters: the water vapor present as a percentage of the maximum the air '
      + 'could hold at its current temperature. Being relative matters — 90 % in polar air is a tiny '
      + 'absolute amount of water, far less than 50 % in the tropics.',
    scale: '0–100 %. Above roughly 95 % the air is effectively at saturation, which is where fog and '
      + 'stratus live.',
    overTime: 'Monsoon onset is unmistakable: a sharp surge of moisture arrives before or with the rain. '
      + 'Because the scale is relative, some of what you see moving is the temperature changing rather than '
      + 'the moisture.',
    trends: 'Absolute moisture rises with warming at roughly 7 % per °C. Relative humidity over land has '
      + 'tended to fall slightly, because land warms faster than the ocean can supply extra moisture to it — '
      + 'a mismatch that raises evaporative demand and matters for drought and fire risk.',
    correlates: [
      { key: 'airtemp', why: 'the denominator of the ratio — you cannot read one without the other' },
      { key: 'precip', why: 'moisture is the fuel; rainfall is the drawdown' },
      { key: 'sst', why: 'warm ocean is the evaporative source for the moist tongues' },
    ],
  },
  pressure: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'Atmospheric pressure reduced to sea level, so that highs and lows over Tibet and over the ocean '
      + 'can be compared on one scale. Switch on the contour toggle in the gear menu to draw isobars.',
    scale: 'Diverging around roughly 1013 hPa, the global mean. Below 980 hPa is a deep storm; the most '
      + 'intense tropical cyclones drop below 950; above 1030 is a strong blocking high. Ignore the '
      + 'values over high terrain — Greenland, Tibet, the Andes: "reduced to sea level" there means '
      + 'extrapolating through kilometers of rock that is not there, and the result is an artifact of '
      + 'the reduction rather than a pressure anyone could measure. Published weather charts usually '
      + 'mask those regions for exactly this reason.',
    overTime: 'The semi-permanent centers — the Azores and North Pacific highs, the Icelandic and Aleutian '
      + 'lows, the vast Siberian winter high — strengthen, weaken and migrate with the seasons, while '
      + 'travelling depressions cross the mid-latitudes as moving minima. What actually drives wind is the '
      + 'pressure GRADIENT, so look for tightly packed isobars rather than for extreme values.',
    trends: 'The large-scale modes of variability live in this field: the North Atlantic Oscillation is the '
      + 'seesaw between the Icelandic low and the Azores high, and the Southern Annular Mode is its ring-'
      + 'shaped equivalent around Antarctica. Both modulate a whole winter\'s storms, rainfall and '
      + 'temperature downstream.',
    correlates: [
      { key: 'windsea', why: 'the gradient drives the wind that raises local seas' },
      { key: 'waves', why: 'deep lows are the source of the world\'s big wave events' },
      { key: 'rain', why: 'frontal rain bands organize around the lows' },
    ],
  },
  solar: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'Downward shortwave radiation reaching the surface — what a flat solar panel lying on the ground '
      + 'would receive, in watts per square meter.',
    scale: '0 to about 1100 W/m². For reference the solar constant at the top of the atmosphere is about '
      + '1361 W/m²; a clear tropical noon at the surface delivers roughly 1000. Zero is simply night.',
    overTime: 'Because every frame is a 12:00 UTC snapshot, the night half of the map is zero and the '
      + 'sunlit band sits over the same longitudes in every frame. Read this as an instantaneous snapshot of '
      + 'insolation, never as a daily or monthly energy total. What varies usefully between frames is the '
      + 'cloud field and the seasonal tilt of the lit band.',
    trends: 'Coverage upstream only extends back to about January 2026, so there is no trend to read here. '
      + 'Historically, surface solar radiation has shown large regional swings from changing aerosol '
      + 'pollution — the "dimming" and later "brightening" observed over Europe and Asia.',
    correlates: [
      { key: 'swup', why: 'the reflected part of exactly this flux; the pair gives you albedo' },
      { key: 'skintemp', why: 'absorbed sunlight is what heats the surface' },
      { key: 'rain', why: 'cloud is the dominant modulator of how much gets through' },
      { key: 'satellite', why: 'see the actual cloud field that is blocking it' },
    ],
  },
  swup: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'Upwelling shortwave radiation at the surface — the sunlight being reflected straight back up. '
      + 'Divided by the downward flux, this is what albedo means.',
    scale: '0 to 400 W/m². High over snow, ice, bright desert sand and thick cloud; strikingly low over open '
      + 'ocean, which is one of the darkest surfaces on Earth and absorbs almost everything that hits it.',
    overTime: 'The seasonal snow line and the sea-ice edge stand out sharply. This is the visible half of '
      + 'the ice-albedo feedback: replace ice with open water and reflection collapses, so more sunlight is '
      + 'absorbed, which melts more ice.',
    correlates: [
      { key: 'solar', why: 'the incoming flux this is a fraction of — compare them to reason about absorbed energy' },
      { key: 'ice', why: 'the brightest natural surface, and the one that is disappearing' },
      { key: 'satellite', why: 'bright in true color is bright here' },
    ],
  },
  lwup: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'Upwelling longwave radiation at the SURFACE — thermal infrared radiated upward by the ground or '
      + 'water itself, set almost entirely by surface temperature through the Stefan–Boltzmann law. Worth '
      + 'being clear about: this is not the top-of-atmosphere outgoing longwave radiation that is commonly '
      + 'abbreviated OLR and used as a tropical-convection proxy. That quantity is what escapes to space '
      + 'after the atmosphere has absorbed and re-emitted, and it runs far lower, around 100–350 W/m².',
    scale: '100 to 600 W/m². A surface at 300 K (27 °C) emits about 459 W/m². Hot deserts exceed the top of '
      + 'this scale and clamp; the cold polar surfaces sit near the bottom.',
    overTime: 'Because emission follows temperature to the fourth power, this field tracks surface '
      + 'temperature almost deterministically and shows the same seasonal march. Its real value is as the '
      + 'loss term in the surface energy budget rather than as an independent pattern.',
    correlates: [
      { key: 'skintemp', why: 'a near-deterministic relationship — this is essentially σT⁴ of that layer' },
      { key: 'lwdown', why: 'the difference between them is the NET longwave cooling of the surface' },
      { key: 'humidity', why: 'water vapor is what returns longwave to the surface, throttling the net loss' },
    ],
  },
  lwdown: {
    cite: { product: 'Global Forecast System (GFS)', provider: 'NOAA NCEP', access: 'live PacIOOS ERDDAP (ncep_global)', url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast' },
    what: 'Downward longwave radiation at the surface — thermal infrared emitted back down by the '
      + 'atmosphere, chiefly by water vapor, carbon dioxide and cloud. This is the greenhouse effect '
      + 'measured directly as an energy flux at the ground.',
    scale: '50 to 500 W/m². Highest in the warm, humid tropics and under thick cloud; lowest over cold, dry, '
      + 'clear air — the Antarctic plateau and high deserts on a clear night.',
    overTime: 'Follows moisture and cloud more than it follows temperature, which makes it the useful '
      + 'counterpart to the upwelling flux. Subtract the two: a dry clear desert loses heat rapidly at night '
      + 'because little comes back down, which is exactly why deserts get cold after dark despite the day\'s '
      + 'extremes. Under humid or cloudy skies the net loss nearly closes and nights stay warm.',
    correlates: [
      { key: 'lwup', why: 'the pair defines net longwave cooling — the quantity that actually matters' },
      { key: 'humidity', why: 'the single biggest control on this flux' },
      { key: 'rain', why: 'cloud raises it sharply' },
    ],
  },

  // ── Life ─────────────────────────────────────────────────────────────────────────────
  obis: {
    cite: {
      product: 'OBIS gridded species occurrences', provider: 'Ocean Biodiversity Information System (UNESCO/IOC)',
      access: 'live api.obis.org /occurrence/grid — millions of records aggregated to cell counts server-side',
      url: 'https://obis.org/',
      license: 'individual records carry their own licences and citations — see the OBIS dataset pages',
    },
    what: 'How many times a species has been RECORDED in each cell, from OBIS — an aggregation of '
      + 'hundreds of millions of marine occurrence records: museum collections, research surveys, '
      + 'fisheries observers, tagging programmes and citizen science, spanning two centuries. Pick the '
      + 'species in the gear menu. Millions of points would be hopeless in a browser, so OBIS grids '
      + 'them server-side and sends back a count per cell.',
    scale: 'Logarithmic record counts, 1 to tens of thousands per cell. Read the CRITICAL caveat with '
      + 'it: this measures observation effort at least as much as it measures animals. The North Sea, '
      + 'the Gulf of Maine and the coasts of western Europe glow because they are surveyed relentlessly '
      + 'and have been for a century — not because they hold more life than the open Pacific, which is '
      + 'mostly dark here because almost nobody is out there looking.',
    overTime: 'There is no time axis: this layer is the whole record collapsed into one field, so the '
      + 'timeline and the analysis views do not apply to it. That also means it mixes a Victorian '
      + 'whaling logbook with last month\'s survey — a distribution shown this way is historical range, '
      + 'not present-day range, and for species whose range has shifted the difference is the point.',
    trends: 'Occurrence counts cannot show a population trend, and it is worth being blunt about why: '
      + 'a rise usually means more observers, better identification, or a new dataset being contributed. '
      + 'For trends you need a survey with consistent effort, which is what stock assessments are for.',
    correlates: [
      { key: 'sst', why: 'thermal range is the first-order control on where a marine species can live' },
      { key: 'chl', why: 'productivity sets where the food is, and predators follow it' },
      { key: 'dhw', why: 'compare a reef species\' range against where heat stress is accumulating' },
    ],
  },

  // ── Human activity ───────────────────────────────────────────────────────────────────
  fishing: {
    cite: {
      product: 'Apparent fishing effort (4wings gridded)', provider: 'Global Fishing Watch',
      access: 'live GFW 4wings vector tiles, decoded in the browser — the one source here needing a token',
      url: 'https://globalfishingwatch.org/dataset-and-code-fishing-effort/',
      license: 'CC BY-SA 4.0 — attribution required, and the token is compiled into this build (see src/geo/live/gfw.ts)',
    },
    what: 'Hours that industrial fishing vessels APPEAR to have spent fishing in each cell over a '
      + 'year. Global Fishing Watch takes AIS position broadcasts — the collision-avoidance system '
      + 'large vessels transmit — and runs a neural-network classifier over each track to decide '
      + 'which segments look like fishing rather than transiting, then sums the hours per cell.',
    scale: 'Logarithmic hours, because effort is extraordinarily concentrated: the East China Sea '
      + 'carries orders of magnitude more than the open Pacific. The scale tops out at 10,000 h and '
      + 'the busiest cells clamp — read the top of the range as "saturated", and the point-readout '
      + 'value for the real number.',
    overTime: 'One complete year per load (`?year=`). Comparing years shows fleets shifting: an El '
      + 'Niño collapsing the Peruvian anchoveta season, a closure taking effect, or a new distant-'
      + 'water fleet arriving on a shelf.',
    trends: 'Rising effort in a region can mean more fishing OR better AIS coverage — adoption and '
      + 'satellite reception both improved markedly through the 2010s. And what is missing matters '
      + 'more than what is here: vessels without AIS, vessels that switch it off, and most small-'
      + 'scale fleets are invisible, so this is a floor on activity, never a census.',
    correlates: [
      { key: 'chl', why: 'fleets work productive water — the effort map is close to a productivity map' },
      { key: 'sst', why: 'target species track thermal fronts, and so do the boats' },
      { key: 'obis', why: 'compare where a species is recorded against where it is being caught' },
    ],
  },

  // ── Imagery (no value scale) ─────────────────────────────────────────────────────────
  satellite: {
    cite: { product: 'VIIRS Corrected Reflectance true color', provider: 'NASA Worldview / GIBS (Suomi-NPP, NOAA-20)', access: 'live GIBS WMTS tiles', url: 'https://worldview.earthdata.nasa.gov/', license: 'Courtesy NASA EOSDIS GIBS' },
    what: 'Daily true-color imagery from the VIIRS instrument on the Suomi-NPP and NOAA-20 satellites, '
      + 'mosaicked from NASA GIBS tiles — approximately what your eye would see looking down from orbit.',
    scale: 'None. This layer is red-green-blue imagery rather than a measured quantity, so the colorbar is '
      + 'hidden and point readouts and the analysis views do not apply to it.',
    overTime: 'A time-lapse of the real thing, back to 2012: cloud, snow cover, Saharan dust plumes, '
      + 'wildfire smoke, river sediment, and phytoplankton blooms visible as color in the water. Because '
      + 'VIIRS is a polar orbiter, each daily frame is stitched from successive passes, so the imagery is a '
      + 'mosaic of slightly different times rather than one instant.',
    correlates: [
      { key: 'chl', why: 'blooms visible as color here are the quantity that layer retrieves' },
      { key: 'ice', why: 'the ice and snow edge you can see directly' },
      { key: 'solar', why: 'the cloud in this image is what modulates the surface flux' },
    ],
  },
  goes: {
    cite: { product: 'GOES-East / GOES-West ABI GeoColor', provider: 'NOAA NESDIS / STAR', access: 'live full-disk JPEGs from the NESDIS CDN, reprojected in the browser', url: 'https://www.star.nesdis.noaa.gov/GOES/', license: 'GeoColor by CIRA/Colorado State University' },
    what: 'A live composite of the GOES-East and GOES-West full disks, reprojected in the browser onto the '
      + 'map grid. GeoColor is a blended product: approximately true color by day, and infrared cloud '
      + 'rendering at night, so weather stays visible around the clock.',
    scale: 'None — imagery, not a measured field.',
    overTime: 'A single current frame rather than a time-lapse; reselect the layer to refresh it. The two '
      + 'satellites together cover the Americas and the Pacific, leaving a gap over Asia, Africa and the '
      + 'Indian Ocean where neither has a view. Best used for the structure of weather happening right now.',
    correlates: [
      { key: 'pressure', why: 'the cloud spirals you see are the lows in that field' },
      { key: 'rain', why: 'the model\'s guess at what these cloud systems are precipitating' },
    ],
  },
};

/**
 * Everything else the map draws that is not a selectable layer: the overlays, the basemaps, the
 * relief, the ENSO record, and the streamed detail imagery. Listed in the ⓘ panel under "All data
 * sources" so no pixel on screen is unattributed — several of these carry licence obligations, and a
 * viewer has no other way to discover what it is looking at.
 */
export const DATA_CREDITS: ReadonlyArray<{ role: string; cite: Citation }> = [
  {
    role: 'Wind overlay (10 m vectors)',
    cite: {
      product: 'Global Forecast System (GFS) 10 m wind', provider: 'NOAA NCEP',
      access: 'live PacIOOS ERDDAP (ncep_global, ugrd10m/vgrd10m)',
      url: 'https://www.ncei.noaa.gov/products/weather-climate-models/global-forecast',
    },
  },
  {
    role: 'Currents overlay',
    cite: {
      product: 'Near-real-time geostrophic surface currents (miamicurrents)', provider: 'NOAA CoastWatch',
      access: 'committed baked atlas — that ERDDAP sends no CORS header, so tools/geo/ prepares it offline',
      url: 'https://coastwatch.noaa.gov/',
    },
  },
  {
    role: 'Animal tracks overlay',
    cite: {
      product: 'Marine animal satellite telemetry (Animal Telemetry Network)',
      provider: 'U.S. IOOS ATN Data Assembly Center; tags deployed by the contributing research programmes',
      access: 'live IOOS ERDDAP (atn_cacheFromUrl_collection), filtered to QARTOD-passed fixes',
      url: 'https://ioos.noaa.gov/project/atn/',
      license: 'each deployment has its own principal investigator and citation — credit them, not the portal',
    },
  },
  {
    role: 'Weather-radar overlay',
    cite: {
      product: 'Global radar mosaic (past ~10 minutes)', provider: 'RainViewer',
      access: 'live RainViewer tile API, reprojected from Web Mercator in the browser',
      url: 'https://www.rainviewer.com/', license: '© RainViewer — attribution required',
    },
  },
  {
    role: 'ENSO record (Oceanic Niño Index)',
    cite: {
      product: 'OISST v2.1 anomaly, monthly Niño 3.4 box means', provider: 'NOAA NCEI (index definition: NOAA CPC)',
      access: 'committed baked series, extended live from NCEI',
      url: 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/ensostuff/ONI_v5.php',
    },
  },
  {
    role: 'Relief / globe terrain',
    cite: {
      product: 'ETOPO1 global relief model', provider: 'NOAA NCEI',
      access: 'committed baked heightmap (tools/geo/bake_topo.mjs)',
      url: 'https://www.ncei.noaa.gov/products/etopo-global-relief-model',
    },
  },
  {
    role: 'Land basemap + night lights',
    cite: {
      product: 'Earth texture maps', provider: 'Solar System Scope',
      access: 'committed image assets',
      url: 'https://www.solarsystemscope.com/textures/', license: 'CC BY 4.0 — attribution required',
    },
  },
  {
    role: 'Deep-zoom detail imagery',
    cite: {
      product: 'Blue Marble Next Generation, and World Imagery for street-level zoom',
      provider: 'NASA GIBS; Esri and its imagery contributors',
      access: 'live tiles, streamed only for the window on screen',
      url: 'https://worldview.earthdata.nasa.gov/', license: 'Esri World Imagery — © Esri and contributors',
    },
  },
  {
    role: 'Geoid (elevation reference)',
    cite: {
      product: 'EGM96 15′ geoid', provider: 'NGA (via GeographicLib)',
      access: 'committed baked grid', url: 'https://geographiclib.sourceforge.io/C++/doc/geoid.html',
    },
  },
  {
    role: 'On-device SST-anomaly forecast',
    cite: {
      product: 'Small CNN trained in-repo on the baked OISST anomaly stack', provider: 'this project (tools/geo/train_forecast.py)',
      access: 'committed .tflite weights, run locally through LiteRT.js',
      url: 'https://www.ncei.noaa.gov/products/optimum-interpolation-sst',
      license: 'a demonstration model, not an operational forecast',
    },
  },
];

/** What each analysis view does to whatever layer is loaded (shown when a derived view is active). */
export const VIEW_NOTES: Record<string, string> = {
  delta: 'Each cell is this frame minus the frame from N years earlier, so the colors are CHANGE, not '
    + 'value. Differencing whole years cancels the seasonal cycle, which is what makes a year-on-year '
    + 'signal visible at all.',
  min: 'The lowest value each cell reached across every frame currently loaded — one static composite. Good '
    + 'for "how cold/calm/dark does this place ever get".',
  max: 'The highest value each cell reached across every frame currently loaded. This is the view for '
    + '"where has it ever been this extreme", and the natural one for the coral alert layers.',
  range: 'Highest minus lowest across the loaded frames — the size of the annual swing. Large in '
    + 'continental interiors and mid-latitude oceans, small in the deep tropics and the abyss of the '
    + 'subtropical gyres. A map of how variable a place is, rather than of how extreme.',
};

/** Runtime context the explorer supplies for the currently displayed layer + view. */
export interface LayerInfoContext {
  /** Layer key — selects the LAYER_INFO entry. */
  key: string;
  /** Layer label for the heading (e.g. "Coral heat stress (DHW)"). */
  label: string;
  /** Colorbar title for the active view (e.g. "Degree heating weeks — max over all years"). */
  legendTitle: string;
  /** Formatted scale endpoints, as the legend shows them. */
  ticks?: { lo: string; mid: string; hi: string };
  /** Upstream attribution, e.g. "NOAA Coral Reef Watch 5 km (PacIOOS)". */
  source?: string;
  /** Coverage floor, `YYYY-MM`. */
  coverage?: string;
  /** Known limitations from the layer's analysis metadata. */
  caveats?: string;
  /** Active analysis view; a note is appended when it is not the plain absolute field. */
  view?: string;
  /** The second layer drawn over this one, when there is one. */
  overlay?: {
    key: string;
    label: string;
    /** How it is being drawn — line interval, and the hatch threshold if it hatches. */
    how: string;
    /** Date of the overlay frame paired to the moment on screen, or null if none is near enough. */
    paired: string | null;
  };
}

export interface LayerInfoPanel {
  /** Render `ctx` and show the panel. */
  show: (ctx: LayerInfoContext) => void;
  hide: () => void;
  visible: () => boolean;
  /** Re-render in place if open (layer/view changed underneath it), otherwise do nothing. */
  refresh: (ctx: LayerInfoContext) => void;
}

/**
 * Installs the info overlay. `onLayer` is invoked when a correlate chip is clicked, so "what else
 * explains this pattern" is one click from being on screen instead of a name to go hunting for.
 * `labelFor` resolves a layer key to its picker label (returns null for keys not in the catalog,
 * which are then skipped — the content table stays valid as layers come and go).
 */
export function installLayerInfoPanel(opts: {
  onLayer: (key: string) => void;
  labelFor: (key: string) => string | null;
}): LayerInfoPanel {
  const css = (el: HTMLElement, s: string): void => { el.style.cssText = s; };

  // Backdrop: dims the map and closes on click, so there is always an obvious way out.
  const scrim = document.createElement('div');
  css(scrim, 'position:fixed;inset:0;z-index:12;display:none;background:rgba(2,4,8,0.55);'
    + 'backdrop-filter:blur(1.5px)');

  const panel = document.createElement('div');
  css(panel, 'position:fixed;z-index:13;display:none;left:50%;top:50%;transform:translate(-50%,-50%);'
    + 'width:min(620px,92vw);max-height:82vh;overflow-y:auto;background:rgba(8,10,14,0.94);'
    + 'border:1px solid rgba(94,240,200,0.25);border-radius:8px;font-family:ui-monospace,monospace;'
    + 'color:#dfeef0;box-shadow:0 6px 32px rgba(0,0,0,0.6);padding:14px 16px 16px;font-size:12.5px;'
    + 'line-height:1.62');

  const header = document.createElement('div');
  css(header, 'display:flex;align-items:baseline;gap:10px;margin-bottom:2px');
  const heading = document.createElement('div');
  css(heading, 'color:#5ef0c8;font-size:14px;font-weight:700;letter-spacing:0.3px;flex:1');
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (Esc)';
  css(closeBtn, 'cursor:pointer;background:none;border:none;color:#889;font-size:15px;padding:0;'
    + 'line-height:1;flex:none');
  header.append(heading, closeBtn);

  const subhead = document.createElement('div');
  css(subhead, 'color:#8fa5ab;font-size:11.5px;margin-bottom:11px');

  const body = document.createElement('div');
  panel.append(header, subhead, body);
  document.body.append(scrim, panel);

  const section = (label: string, text: string): HTMLElement => {
    const wrap = document.createElement('div');
    css(wrap, 'margin-bottom:11px');
    const h = document.createElement('div');
    css(h, 'color:#9fd8cf;font-size:10.5px;letter-spacing:1.1px;text-transform:uppercase;margin-bottom:2px');
    h.textContent = label;
    const p = document.createElement('div');
    p.textContent = text;
    wrap.append(h, p);
    return wrap;
  };

  const hide = (): void => {
    panel.style.display = 'none';
    scrim.style.display = 'none';
  };
  scrim.addEventListener('click', hide);
  closeBtn.addEventListener('click', hide);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.style.display !== 'none') {
      e.preventDefault();
      hide();
    }
  });

  const render = (ctx: LayerInfoContext): void => {
    const info = LAYER_INFO[ctx.key];
    heading.textContent = ctx.label;
    const bits = [ctx.legendTitle];
    if (ctx.ticks && ctx.ticks.lo) {
      bits.push(`scale ${ctx.ticks.lo} → ${ctx.ticks.hi}`);
    }
    if (ctx.source) {
      bits.push(ctx.source);
    }
    if (ctx.coverage) {
      bits.push(`from ${ctx.coverage}`);
    }
    subhead.textContent = bits.join(' · ');

    body.textContent = '';
    if (!info) {
      body.append(section('No description yet', 'This layer has no entry in the info catalog.'));
      return;
    }
    body.append(section('What it is', info.what));
    body.append(section('Reading the scale', info.scale));
    if (info.overTime) {
      body.append(section('Over time', info.overTime));
    }
    if (info.trends) {
      body.append(section('Trends', info.trends));
    }
    // The active analysis view rewrites what every cell means, so explain it here rather than
    // leaving the layer prose (which describes the absolute field) to be read as if it still applied.
    const viewNote = ctx.view && ctx.view !== 'abs' ? VIEW_NOTES[ctx.view] : undefined;
    if (viewNote) {
      body.append(section('This view', viewNote));
    }
    // With two layers up, say plainly what the second one is and how the two were time-aligned —
    // an overlay silently snapped to a frame months away from the base would be badly misleading.
    if (ctx.overlay) {
      const o = ctx.overlay;
      const pairNote = o.paired
        ? `Showing its ${o.paired} frame, paired to the date on screen.`
        : 'No frame of it falls near the date on screen, so nothing is drawn over the base right now — '
          + 'usually the overlay\'s record starts later than the base\'s.';
      const oInfo = LAYER_INFO[o.key];
      const wrap = document.createElement('div');
      css(wrap, 'margin-bottom:11px;padding:7px 9px;background:rgba(94,240,200,0.06);'
        + 'border-left:2px solid rgba(94,240,200,0.4);border-radius:0 4px 4px 0');
      const h = document.createElement('div');
      css(h, 'color:#9fd8cf;font-size:10.5px;letter-spacing:1.1px;text-transform:uppercase;margin-bottom:2px');
      h.textContent = `Overlay — ${o.label}`;
      const p = document.createElement('div');
      p.textContent = `${o.how} ${pairNote}`;
      wrap.append(h, p);
      if (oInfo) {
        const scale = document.createElement('div');
        css(scale, 'margin-top:5px;color:#b9c9cc');
        scale.textContent = oInfo.scale;
        wrap.append(scale);
      }
      body.append(wrap);
    }
    if (info.correlates?.length) {
      const wrap = document.createElement('div');
      css(wrap, 'margin-bottom:11px');
      const h = document.createElement('div');
      css(h, 'color:#9fd8cf;font-size:10.5px;letter-spacing:1.1px;text-transform:uppercase;margin-bottom:4px');
      h.textContent = 'Correlated layers — click to switch';
      wrap.append(h);
      for (const c of info.correlates) {
        const label = opts.labelFor(c.key);
        if (!label) {
          continue;   // catalog references a layer this build does not have
        }
        const row = document.createElement('div');
        css(row, 'display:flex;gap:7px;align-items:baseline;margin-bottom:3px');
        const chip = document.createElement('button');
        chip.textContent = label;
        chip.title = `Switch to ${label}`;
        css(chip, 'cursor:pointer;flex:none;background:#1b2530;color:#5ef0c8;border:1px solid #2f4a52;'
          + 'border-radius:10px;padding:1px 9px;font-size:11px;font-family:inherit;white-space:nowrap');
        chip.addEventListener('click', () => {
          hide();
          opts.onLayer(c.key);
        });
        const why = document.createElement('span');
        css(why, 'color:#b9c9cc');
        why.textContent = c.why;
        row.append(chip, why);
        wrap.append(row);
      }
      body.append(wrap);
    }
    if (ctx.caveats) {
      body.append(section('Caveats', ctx.caveats));
    }

    // Provenance, always last and always present: product, producer, the path the bytes took, and a
    // link. `ctx.source` is what the loader itself reports, so a mismatch with the citation is
    // visible rather than hidden behind prose.
    const c = info.cite;
    const src = document.createElement('div');
    css(src, 'margin-top:13px;padding-top:9px;border-top:1px solid rgba(255,255,255,0.12)');
    const sh = document.createElement('div');
    css(sh, 'color:#9fd8cf;font-size:10.5px;letter-spacing:1.1px;text-transform:uppercase;margin-bottom:3px');
    sh.textContent = 'Source';
    const link = document.createElement('a');
    link.href = c.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = c.product;
    css(link, 'color:#5ef0c8;text-decoration:none');
    const who = document.createElement('div');
    css(who, 'color:#b9c9cc;margin-top:1px');
    who.textContent = `${c.provider} · ${c.access}`;
    src.append(sh, link, who);
    if (c.license) {
      const lic = document.createElement('div');
      css(lic, 'color:#8fa5ab;font-size:11.5px;margin-top:2px');
      lic.textContent = c.license;
      src.append(lic);
    }
    body.append(src);

    // Everything else on screen — overlays, basemaps, relief, imagery — behind one disclosure, so
    // the whole display is attributable without burying the layer's own citation.
    const all = document.createElement('details');
    css(all, 'margin-top:9px;color:#b9c9cc');
    const sum = document.createElement('summary');
    sum.textContent = 'All data sources on this map';
    css(sum, 'cursor:pointer;color:#8fa5ab;font-size:11.5px');
    all.append(sum);
    for (const entry of DATA_CREDITS) {
      const row = document.createElement('div');
      css(row, 'margin-top:6px;font-size:11.5px');
      const a = document.createElement('a');
      a.href = entry.cite.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = entry.cite.product;
      css(a, 'color:#5ef0c8;text-decoration:none');
      const meta = document.createElement('div');
      css(meta, 'color:#8fa5ab');
      meta.textContent = `${entry.cite.provider} · ${entry.cite.access}`
        + (entry.cite.license ? ` · ${entry.cite.license}` : '');
      const role = document.createElement('span');
      css(role, 'color:#9fd8cf');
      role.textContent = `${entry.role}: `;
      row.append(role, a, meta);
      all.append(row);
    }
    body.append(all);
  };

  return {
    show: (ctx) => {
      render(ctx);
      scrim.style.display = 'block';
      panel.style.display = 'block';
      panel.scrollTop = 0;
    },
    hide,
    visible: () => panel.style.display !== 'none',
    refresh: (ctx) => {
      if (panel.style.display !== 'none') {
        render(ctx);
      }
    },
  };
}
