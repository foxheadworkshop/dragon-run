// URL-hash codecs. Two forms:
//   #t=<tripId>           — shared live trip (Firestore)
//   #s=z:<b64url deflate> — full local state snapshot ('j:' = plain JSON fallback)

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const b64 = str.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function pipe(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeStateHash(snapshot) {
  const raw = new TextEncoder().encode(JSON.stringify(snapshot));
  if (typeof CompressionStream !== 'undefined') {
    const z = await pipe(raw, new CompressionStream('deflate-raw'));
    return '#s=z:' + b64urlEncode(z);
  }
  return '#s=j:' + b64urlEncode(raw);
}

export async function decodeHash(hash) {
  if (!hash || hash.length < 3) return null;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (h.startsWith('t=')) return { tripId: h.slice(2) };
  if (!h.startsWith('s=')) return null;
  const body = h.slice(2);
  try {
    if (body.startsWith('z:')) {
      const raw = await pipe(b64urlDecode(body.slice(2)), new DecompressionStream('deflate-raw'));
      return { state: JSON.parse(new TextDecoder().decode(raw)) };
    }
    if (body.startsWith('j:')) {
      return { state: JSON.parse(new TextDecoder().decode(b64urlDecode(body.slice(2)))) };
    }
  } catch (e) {
    console.warn('Could not decode share hash', e);
  }
  return null;
}
