// ---------------------------------------------------------------------------
// Browser-side image downscaling
// ---------------------------------------------------------------------------
// Menu photos are taken on a phone, where a single shot is comfortably 4-5 MB
// and several thousand pixels wide — far more than a menu thumbnail can use.
// Shrinking in the browser before uploading means the server never has to
// process images (no sharp / imagemagick to install), uploads finish quickly on
// a phone's connection, and a real photo lands well under the 5 MB cap.
//
// A dish photo is only ever shown small — 88x88 in the customer list, 64x64 in
// the owner form, 40x40 in the stock list. So the longest side is capped well
// below the old 1200px (which downloaded ~200 KB to paint 88 px), and the file
// is a WebP: a 4000x3000 5 MB photo comes out around 20-30 KB at these settings,
// roughly 10x smaller than before, so the list paints far faster on mobile data.
// The cap still leaves generous retina headroom (500 px into an 88 px slot).
// ---------------------------------------------------------------------------

const MAX_EDGE = 500; // longest side, in pixels
const QUALITY = 0.8;  // WebP quality

// Read a File into an <img> we can draw. Object URLs are revoked either way so
// a rejected file doesn't leak the blob for the life of the page.
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพนี้ได้'));
    };
    img.src = url;
  });
}

// File -> a smaller WebP File, ready to upload.
//
// Images already within the limit are still re-encoded rather than passed
// through: it strips EXIF (which carries the GPS coordinates of wherever the
// photo was taken) and guarantees the upload is one of the three types the
// server accepts, whatever the phone produced.
export async function shrinkImage(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);

  const ctx = canvas.getContext('2d');
  // A photo drawn onto a fresh canvas keeps transparent pixels, which JPEG
  // renders black. Filling white first keeps a transparent PNG looking right.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('ย่อรูปภาพไม่สำเร็จ'))),
      'image/webp',
      QUALITY
    );
  });

  return new File([blob], 'menu.webp', { type: 'image/webp' });
}
