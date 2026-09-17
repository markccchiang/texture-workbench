// Colour conversions: how a colour image becomes the gray image that is measured (core/imaging/ColourConversion.hpp)

import { Type, type Static } from 'typebox';

export const COLOUR_CONVERSION_IDS = [
  'luminance',
  'mean',
  'red',
  'green',
  'blue',
  'hue',
  'saturation',
  'brightness',
  'hematoxylinHe',
  'eosinHe',
  'hematoxylinHdab',
  'dabHdab',
] as const;

export const ColourConversion = Type.Union(
  [
    Type.Literal('luminance'),
    Type.Literal('mean'),
    Type.Literal('red'),
    Type.Literal('green'),
    Type.Literal('blue'),
    Type.Literal('hue'),
    Type.Literal('saturation'),
    Type.Literal('brightness'),
    Type.Literal('hematoxylinHe'),
    Type.Literal('eosinHe'),
    Type.Literal('hematoxylinHdab'),
    Type.Literal('dabHdab'),
  ],
  {
    description:
      'luminance: 0.299 R + 0.587 G + 0.114 B (the conversion of an upload); mean: (R + G + B) / 3; red, green, blue: one channel; hue, saturation, brightness: HSB components as ImageJ computes them; hematoxylinHe, eosinHe, hematoxylinHdab, dabHdab: stain optical densities by colour deconvolution (scikit-image separate_stains), stored as 16-bit samples with a value conversion',
  },
);
export type ColourConversion = Static<typeof ColourConversion>;

export interface ColourConversionOption {
  id: ColourConversion;
  /** Shown in menus and dialogs */
  label: string;
  /** Appended to the image name in brackets, e.g. "slide.jpg [red]" */
  suffix: string;
  group: 'Gray' | 'Channels' | 'HSB' | 'Stains';
}

export const COLOUR_CONVERSIONS: readonly ColourConversionOption[] = [
  { id: 'luminance', label: 'Luminance', suffix: 'luminance', group: 'Gray' },
  { id: 'mean', label: 'Mean of R, G, B', suffix: 'mean', group: 'Gray' },
  { id: 'red', label: 'Red', suffix: 'red', group: 'Channels' },
  { id: 'green', label: 'Green', suffix: 'green', group: 'Channels' },
  { id: 'blue', label: 'Blue', suffix: 'blue', group: 'Channels' },
  { id: 'hue', label: 'Hue', suffix: 'hue', group: 'HSB' },
  { id: 'saturation', label: 'Saturation', suffix: 'saturation', group: 'HSB' },
  { id: 'brightness', label: 'Brightness', suffix: 'brightness', group: 'HSB' },
  { id: 'hematoxylinHe', label: 'Hematoxylin (H&E)', suffix: 'hematoxylin H&E', group: 'Stains' },
  { id: 'eosinHe', label: 'Eosin (H&E)', suffix: 'eosin H&E', group: 'Stains' },
  { id: 'hematoxylinHdab', label: 'Hematoxylin (H-DAB)', suffix: 'hematoxylin H-DAB', group: 'Stains' },
  { id: 'dabHdab', label: 'DAB (H-DAB)', suffix: 'DAB H-DAB', group: 'Stains' },
];

export function colourConversionOption(id: ColourConversion): ColourConversionOption {
  return COLOUR_CONVERSIONS.find((option) => option.id === id)!;
}

export const ColourSource = Type.Object(
  {
    imageId: Type.String({ description: 'The colour image this image was converted from' }),
    conversion: ColourConversion,
  },
  { description: 'Present on images made by POST /images/{id}/colour' },
);
export type ColourSource = Static<typeof ColourSource>;

export const ColourConversionRequest = Type.Object({ conversion: ColourConversion });
export type ColourConversionRequest = Static<typeof ColourConversionRequest>;

export const ColourPreviewQuery = Type.Object({
  conversion: ColourConversion,
  maxSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384, description: 'Largest long side; capped by the server limit' })),
});
export type ColourPreviewQuery = Static<typeof ColourPreviewQuery>;
