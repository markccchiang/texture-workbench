// Image ▸ Colour Conversion…: how a colour image becomes the gray image that is measured, with a preview rendered by the server

import { COLOUR_CONVERSIONS, type ColourConversion, type ImageInfo } from '@glcm/api';
import { Button, Group, Loader, Radio, SimpleGrid, Stack, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { fetchColourPreview } from '../api/client';
import { openColourConversion } from '../stores/imageLoader';
import { useViewer } from '../stores/viewerStore';

const PREVIEW_SIZE = 280;
const GROUPS = ['Gray', 'Channels', 'HSB', 'Stains'] as const;

const DESCRIPTIONS: Record<ColourConversion, string> = {
  luminance: 'The weighted sum 0.299 R + 0.587 G + 0.114 B, as colour images open.',
  mean: 'The unweighted mean (R + G + B) / 3, like ImageJ with "Unweighted RGB conversions".',
  red: 'The red channel unchanged.',
  green: 'The green channel unchanged.',
  blue: 'The blue channel unchanged.',
  hue: "The hue of ImageJ's HSB stack, 0–255 around the colour circle from red.",
  saturation: "The saturation of ImageJ's HSB stack: (max − min) / max, times 255.",
  brightness: "The brightness of ImageJ's HSB stack: the largest channel.",
  hematoxylinHe: 'Hematoxylin optical density of an H&E stain, by colour deconvolution; stored as 16-bit values with their scale.',
  eosinHe: 'Eosin optical density of an H&E stain, by colour deconvolution; stored as 16-bit values with their scale.',
  hematoxylinHdab: 'Hematoxylin optical density of an H-DAB stain (immunohistochemistry), by colour deconvolution.',
  dabHdab: 'DAB optical density of an H-DAB stain (immunohistochemistry), by colour deconvolution.',
};

/** The colour image can be converted: it is one, or was converted from one */
export function canConvertColour(info: ImageInfo | undefined): boolean {
  return info !== undefined && (info.colourSource !== undefined || info.sourceChannels >= 3);
}

function usePreview(imageId: string, conversion: ColourConversion) {
  const [preview, setPreview] = useState<{ url: string; conversion: ColourConversion } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // Twice the size for high-density screens
    fetchColourPreview(imageId, conversion, PREVIEW_SIZE * 2, controller.signal)
      .then((blob) => {
        if (urlRef.current) {
          URL.revokeObjectURL(urlRef.current);
        }
        urlRef.current = URL.createObjectURL(blob);
        setPreview({ url: urlRef.current, conversion });
        setError(null);
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) {
          setError(reason.message);
        }
      });
    return () => controller.abort();
  }, [imageId, conversion]);

  useEffect(
    () => () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
      }
    },
    [],
  );
  return { preview, error };
}

export function ColourConversionContent({ onClose }: { onClose(): void }) {
  const info = useViewer((state) => state.image?.info);
  const current = info?.colourSource?.conversion ?? 'luminance';
  const [conversion, setConversion] = useState<ColourConversion>(current);
  const { preview, error } = usePreview(info?.imageId ?? '', conversion);

  if (!info || !canConvertColour(info)) {
    return (
      <Text size="sm" c="dimmed">
        Open a colour image first.
      </Text>
    );
  }
  const width = info.width >= info.height ? PREVIEW_SIZE : Math.round((PREVIEW_SIZE * info.width) / info.height);
  const height = info.width >= info.height ? Math.round((PREVIEW_SIZE * info.height) / info.width) : PREVIEW_SIZE;
  const apply = () => {
    onClose();
    void openColourConversion(conversion);
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Texture is measured on one gray value per pixel. Choose which one a colour pixel gives; the conversion is kept with the image and its results.
      </Text>
      <Group align="flex-start" gap="lg" wrap="wrap">
        <Radio.Group value={conversion} onChange={(value) => setConversion(value as ColourConversion)} aria-label="Conversion" style={{ flex: '1 1 220px' }}>
          <SimpleGrid cols={2} spacing="sm" verticalSpacing="xs">
            {GROUPS.map((group) => (
              <Stack key={group} gap={6}>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                  {group}
                </Text>
                {COLOUR_CONVERSIONS.filter((option) => option.group === group).map((option) => (
                  <Radio key={option.id} value={option.id} label={option.label} size="sm" />
                ))}
              </Stack>
            ))}
          </SimpleGrid>
        </Radio.Group>
        <div className="volume-preview-frame" style={{ width, height }}>
          {preview && (
            <img src={preview.url} alt={`Preview: ${conversion}`} data-testid="colour-preview" data-shows={preview.conversion} style={{ width, height }} />
          )}
          {preview?.conversion !== conversion && !error && <Loader size="sm" className="volume-preview-loader" />}
          {error && (
            <Text size="sm" c="red" className="volume-preview-error">
              {error}
            </Text>
          )}
        </div>
      </Group>
      <Text size="sm" data-testid="colour-description">
        {DESCRIPTIONS[conversion]}
      </Text>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={conversion === current} onClick={apply}>
          Convert
        </Button>
      </Group>
    </Stack>
  );
}
