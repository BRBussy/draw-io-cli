import { inflateRawSync } from "node:zlib";

/**
 * Reads the mxfile XML embedded in a .drawio.png buffer. The model sits in
 * a PNG tEXt chunk keyed "mxfile", URL-encoded.
 */
export function mxfileFromPng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) {
    throw new Error("not a PNG file");
  }
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      if (nul !== -1 && data.toString("latin1", 0, nul) === "mxfile") {
        return decodeURIComponent(data.toString("latin1", nul + 1));
      }
    }
    offset += 12 + length;
  }
  throw new Error("no tEXt chunk keyed mxfile found in PNG");
}

/**
 * Reads the mxfile XML embedded in a .drawio.svg string. The model sits in
 * the content attribute of the root svg element, HTML-entity encoded.
 */
export function mxfileFromSvg(svg) {
  const root = svg.match(/<svg\b[^>]*\scontent="([^"]*)"/s);
  if (!root) {
    throw new Error("no content attribute found on the root svg element");
  }
  return decodeEntities(root[1]);
}

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return String.fromCodePoint(code);
    }
    const named = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }[entity];
    return named ?? whole;
  });
}

/**
 * Expands every compressed diagram payload in an mxfile so the result is
 * fully uncompressed XML. A compressed payload is deflate(raw), base64,
 * URL-encoded text. Plain-XML payloads pass through unchanged.
 */
export function uncompressMxfile(xml) {
  return xml.replace(
    /(<diagram\b[^>]*>)([\s\S]*?)(<\/diagram>)/g,
    (whole, open, payload, close) => {
      const trimmed = payload.trim();
      if (trimmed === "" || trimmed.includes("<")) return whole;
      const inflated = inflateRawSync(Buffer.from(trimmed, "base64")).toString("utf8");
      return open + decodeURIComponent(inflated) + close;
    },
  );
}

/**
 * Extracts the uncompressed mxfile XML from a .drawio.png or .drawio.svg
 * buffer, choosing the parser by content rather than file name.
 */
export function extractMxfile(buffer) {
  const isPng = buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
  const embedded = isPng ? mxfileFromPng(buffer) : mxfileFromSvg(buffer.toString("utf8"));
  return uncompressMxfile(embedded);
}

/**
 * Replaces embedded image payloads with size markers so the XML becomes
 * readable. The result is for reading only: it no longer renders.
 */
export function elideImagePayloads(xml) {
  return xml.replace(
    /(image=data:image\/[a-zA-Z+.-]+[;,](?:base64,)?)[A-Za-z0-9+/=%]+/g,
    (whole, head) => `${head}[elided ${Math.max(1, Math.round((whole.length - head.length) / 1024))}KB]`,
  );
}

/**
 * Decodes numeric character references (&#39; and friends) so byte-level
 * greps match the source spelling. Structural characters (quote, ampersand,
 * angle brackets) stay encoded, keeping the XML well-formed.
 */
export function decodeNumericEntities(xml) {
  const structural = new Set([34, 38, 60, 62]);
  return xml.replace(/&#(x?[0-9a-fA-F]+);/g, (whole, num) => {
    const code = num[0] === "x" || num[0] === "X" ? parseInt(num.slice(1), 16) : parseInt(num, 10);
    if (!Number.isFinite(code) || structural.has(code)) return whole;
    return String.fromCodePoint(code);
  });
}
