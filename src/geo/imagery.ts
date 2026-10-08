/**
 * Web Mercator (EPSG:3857) XYZ raster imagery providers.
 *
 * The explorer's detail window (live/tile_window.ts) streams Esri World Imagery at deep zoom and
 * reprojects it into its equirect window. No API key required for light/dev use; attribution
 * ("Esri, Maxar, Earthstar Geographics, …") must be displayed while its tiles are on screen.
 */

/** Esri World Imagery max native zoom (deeper 404s in many areas). */
const MAX_IMAGERY_ZOOM = 19;

/** A Web Mercator `{z}/{x}/{y}` tile address. */
export interface MercTile {
  z: number;
  x: number;
  y: number;
}

/** A Web Mercator (EPSG:3857) XYZ raster imagery source. */
export interface ImageryProvider {
  /** Short provider name (for logs / a layer picker). */
  readonly label: string;
  /** Attribution HTML that must be shown while this provider is on screen. */
  readonly attribution: string;
  /** Deepest native zoom; deeper tiles 404, so requests clamp to this. */
  readonly maxZoom: number;
  /** Tile edge in px (256 for every standard slippy-map provider). */
  readonly tileSize: number;
  /** URL of a single `{z}/{x}/{y}` tile. */
  url(tile: MercTile): string;
}

/** Esri World Imagery: global aerial, no key for light/dev use.
 *  Note the non-standard `/{z}/{row}/{col}` = `/{z}/{y}/{x}` path order. */
export const ESRI_WORLD_IMAGERY: ImageryProvider = {
  label: 'Esri World Imagery',
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  maxZoom: MAX_IMAGERY_ZOOM,
  tileSize: 256,
  url: (t) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${t.z}/${t.y}/${t.x}`,
};
