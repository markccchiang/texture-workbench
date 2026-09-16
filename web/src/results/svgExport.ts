// A chart outside the app: colours that come from CSS variables are resolved, and a background is added. inlineSvg
// gives the markup (for the HTML report), standaloneSvg a complete SVG file.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function inlineSvg(svg: SVGSVGElement, background: string): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const sources = [svg, ...svg.querySelectorAll('*')];
  const targets = [clone, ...clone.querySelectorAll('*')];
  sources.forEach((source, index) => {
    const style = getComputedStyle(source);
    for (const property of ['fill', 'stroke'] as const) {
      if (targets[index].getAttribute(property)?.includes('var(')) {
        targets[index].setAttribute(property, style.getPropertyValue(property));
      }
    }
    // Interaction state is not part of the drawing
    targets[index].removeAttribute('opacity');
  });
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('font-family', getComputedStyle(svg).fontFamily);
  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.setAttribute('width', '100%');
  rect.setAttribute('height', '100%');
  rect.setAttribute('fill', background);
  clone.insertBefore(rect, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

export function standaloneSvg(svg: SVGSVGElement, background: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${inlineSvg(svg, background)}\n`;
}
