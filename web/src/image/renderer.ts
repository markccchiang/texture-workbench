// Window/level renderers for images with raw transfer (doc/ui-design-plan.md, section 6.1).
//
// The WebGL2 renderer uploads the samples once as an unsigned-integer texture and evaluates the integer window/level
// formula in the fragment shader, so its output equals windowLevel() exactly. The display value then selects a colour
// from the colour table, a 256 × 1 RGB texture. The LUT renderer is the fallback.

import { renderToRgba } from './lut';
import type { RawImage } from './raw';

export interface ImageRenderer {
  readonly kind: 'webgl2' | 'lut';
  /** Canvas of the image size holding the last rendering; used as the Konva image source */
  readonly canvas: HTMLCanvasElement;
  /** table: 256 RGB bytes for the display values (colorTables.ts) */
  render(windowMin: number, windowMax: number, table: Uint8Array): void;
  /** Shows other samples of the same size and bit depth (another slice of a stack); render() draws them */
  setSamples(image: RawImage): void;
  dispose(): void;
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// gl_FragCoord addresses output pixel centres; texelFetch reads the matching sample without interpolation.
// (v - min) * 510 + range stays below 2^32 for 16-bit samples.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;
uniform usampler2D u_image;
uniform sampler2D u_table;
uniform uint u_min;
uniform uint u_max;
out vec4 out_color;
void main() {
  ivec2 size = textureSize(u_image, 0);
  ivec2 position = ivec2(gl_FragCoord.xy);
  uint value = texelFetch(u_image, ivec2(position.x, size.y - 1 - position.y), 0).r;
  uint display;
  if (u_max == u_min) {
    display = value >= u_min ? 255u : 0u;
  } else if (value <= u_min) {
    display = 0u;
  } else if (value >= u_max) {
    display = 255u;
  } else {
    uint range = u_max - u_min;
    display = ((value - u_min) * 510u + range) / (2u * range);
  }
  // An RGB8 texel is byte / 255, which the 8-bit canvas stores as the same byte
  out_color = vec4(texelFetch(u_table, ivec2(int(display), 0), 0).rgb, 1.0);
}
`;

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Could not create a shader');
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compilation failed: ${log}`);
  }
  return shader;
}

/**
 * WebGL2 renderer, or null when WebGL2 is unavailable or the image exceeds MAX_TEXTURE_SIZE. onContextLost is called
 * when the browser takes the context away (GPU reset, driver update, too many contexts); the renderer then draws
 * nothing, and the caller should replace it.
 */
export function createWebGlRenderer(image: RawImage, onContextLost?: () => void): ImageRenderer | null {
  const canvas = createCanvas(image.width, image.height);
  // preserveDrawingBuffer: Konva copies the canvas whenever it redraws, not only right after render()
  const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, depth: false, alpha: false });
  if (!gl) {
    return null;
  }
  const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (image.width > maxTextureSize || image.height > maxTextureSize) {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }

  const program = gl.createProgram();
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Shader linking failed: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);

  // One triangle covering the viewport
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  const upload = (samples: RawImage) => {
    gl.activeTexture(gl.TEXTURE0);
    if (samples.bitDepth === 16) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16UI, samples.width, samples.height, 0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, samples.samples);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8UI, samples.width, samples.height, 0, gl.RED_INTEGER, gl.UNSIGNED_BYTE, samples.samples);
    }
  };
  upload(image);
  if (gl.getError() !== gl.NO_ERROR) {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return null;
  }

  gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);

  const tableTexture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, tableTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(gl.getUniformLocation(program, 'u_table'), 1);
  let uploadedTable: Uint8Array | null = null;
  const minLocation = gl.getUniformLocation(program, 'u_min');
  const maxLocation = gl.getUniformLocation(program, 'u_max');
  gl.viewport(0, 0, image.width, image.height);

  let disposed = false;
  const onLost = () => {
    // dispose() loses the context on purpose
    if (!disposed) {
      onContextLost?.();
    }
  };
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    kind: 'webgl2',
    canvas,
    render(windowMin, windowMax, table) {
      if (gl.isContextLost()) {
        return;
      }
      if (table !== uploadedTable) {
        gl.activeTexture(gl.TEXTURE1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 256, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, table);
        uploadedTable = table;
      }
      gl.uniform1ui(minLocation, windowMin);
      gl.uniform1ui(maxLocation, windowMax);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    setSamples(samples) {
      if (samples.width !== image.width || samples.height !== image.height || samples.bitDepth !== image.bitDepth) {
        throw new Error('The samples differ in size or bit depth from the image');
      }
      if (!gl.isContextLost()) {
        upload(samples);
      }
    },
    dispose() {
      disposed = true;
      canvas.removeEventListener('webglcontextlost', onLost);
      gl.deleteTexture(texture);
      gl.deleteTexture(tableTexture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

/** Lookup-table renderer on a 2D canvas */
export function createLutRenderer(image: RawImage): ImageRenderer {
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas 2D is not available');
  }
  const imageData = context.createImageData(image.width, image.height);
  let current = image;
  return {
    kind: 'lut',
    canvas,
    render(windowMin, windowMax, table) {
      renderToRgba(current, windowMin, windowMax, imageData.data, table);
      context.putImageData(imageData, 0, 0);
    },
    setSamples(samples) {
      if (samples.width !== image.width || samples.height !== image.height || samples.bitDepth !== image.bitDepth) {
        throw new Error('The samples differ in size or bit depth from the image');
      }
      current = samples;
    },
    dispose() {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

/** WebGL2 when possible, otherwise the LUT renderer; throws only if neither works (the caller then uses display.png) */
export function createRenderer(image: RawImage, options: { allowWebGl?: boolean; onContextLost?: () => void } = {}): ImageRenderer {
  if (options.allowWebGl !== false) {
    try {
      const renderer = createWebGlRenderer(image, options.onContextLost);
      if (renderer) {
        return renderer;
      }
    } catch (error) {
      console.warn('WebGL2 renderer unavailable, using the lookup-table renderer', error);
    }
  }
  return createLutRenderer(image);
}
