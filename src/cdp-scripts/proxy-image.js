// Proxy an image from AG's DOM by drawing to canvas and returning a data URL.
// Used by GET /proxy-image.
// Parameters: safeSrc — JSON.stringify'd src URL string

export function buildProxyImageScript(safeSrc) {
  return `
    (() => {
      const targetSrc = ${safeSrc};
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        if (img.src !== targetSrc && img.getAttribute('src') !== targetSrc) continue;
        if (!img.complete || img.naturalWidth === 0) continue;

        try {
          const MAX_WIDTH = 800;
          let w = img.naturalWidth;
          let h = img.naturalHeight;
          if (w > MAX_WIDTH) {
            h = Math.round(h * (MAX_WIDTH / w));
            w = MAX_WIDTH;
          }
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL('image/png');
        } catch (e) {
          // CORS / tainted canvas
          return null;
        }
      }
      return null;
    })()
  `;
}
