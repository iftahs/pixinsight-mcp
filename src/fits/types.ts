export type FrameType = "light" | "dark" | "flat" | "bias" | "flatdark" | "unknown";

export interface FitsHeader {
  /** Raw cards as key → value (parsed: number | string | boolean). */
  cards: Record<string, number | string | boolean>;
  comments: Record<string, string>;
  /** Number of 2880-byte header blocks read. */
  blocks: number;
  /** Byte offset of the data unit. */
  dataOffset: number;
}

export interface FrameRecord {
  path: string;
  file: string;
  size_bytes: number;
  type: FrameType;
  /** How the type was decided. */
  type_source: "IMAGETYP" | "path" | "filename" | "unknown";
  imagetyp?: string;
  exptime?: number;
  gain?: number;
  offset?: number;
  ccd_temp?: number;
  set_temp?: number;
  binning: number;
  instrume?: string;
  filter?: string;
  bayerpat?: string;
  date_obs?: string;
  object?: string;
  focallen?: number;
  xpixsz?: number;
  width?: number;
  height?: number;
  focuspos?: number;
  ra?: number;
  dec?: number;
  telescop?: string;
  creator?: string;
  /** Group key components. */
  group_key: string;
}

export interface FrameGroup {
  id: string;
  type: FrameType;
  /** Human label e.g. "Light M 31 180s g100 -10°C". */
  label: string;
  target?: string;
  instrume?: string;
  exptime?: number;
  gain?: number;
  offset?: number;
  binning: number;
  filter?: string;
  bayerpat?: string;
  /** Median of CCD-TEMP across frames. */
  ccd_temp_median?: number;
  ccd_temp_min?: number;
  ccd_temp_max?: number;
  set_temp?: number;
  date_first?: string;
  date_last?: string;
  focuspos_median?: number;
  count: number;
  total_exposure_s: number;
  dims?: [number, number];
  files: string[];
  /** Directory that contains most of the files. */
  dir: string;
}
