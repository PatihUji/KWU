import { head, put } from "@vercel/blob";
import { timingSafeEqual } from "node:crypto";

export const config = { api: { bodyParser: false } };

const BLOB_PATH = "qris/payment-qris";
const MAX_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function reply(res, status, payload) {
  res.status(status).json(payload);
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error("FILE_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function passwordMatches(received, expected) {
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

function imageMatchesType(buffer, contentType) {
  if (contentType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (contentType === "image/jpeg") {
    return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  }
  if (contentType === "image/webp") {
    return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const blob = await head(BLOB_PATH);
      return reply(res, 200, { available: true, url: blob.url });
    } catch (error) {
      if (error.status === 404 || error.code === "blob_not_found") {
        return reply(res, 200, { available: false });
      }
      console.error("QRIS lookup failed", error);
      return reply(res, 500, { error: "QRIS gagal dimuat dari Blob." });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return reply(res, 405, { error: "Metode tidak didukung." });
  }

  const expectedPassword = process.env.QRIS_ADMIN_PASSWORD;
  if (!expectedPassword) {
    return reply(res, 503, { error: "QRIS_ADMIN_PASSWORD belum disetel di Vercel." });
  }
  if (!passwordMatches(req.headers["x-qris-admin-password"], expectedPassword)) {
    return reply(res, 401, { error: "Password admin QRIS salah." });
  }

  const contentType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    return reply(res, 415, { error: "Format gambar harus PNG, JPG, atau WebP." });
  }
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_BYTES) {
    return reply(res, 413, { error: "Ukuran gambar maksimal 4 MB." });
  }

  try {
    const image = await readRequestBody(req);
    if (!image.length) return reply(res, 400, { error: "File gambar kosong." });
    if (!imageMatchesType(image, contentType)) {
      return reply(res, 415, { error: "Isi file tidak cocok dengan format gambar yang dipilih." });
    }
    const blob = await put(BLOB_PATH, image, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      cacheControlMaxAge: 60,
    });
    return reply(res, 200, { success: true, url: blob.url });
  } catch (error) {
    if (error.message === "FILE_TOO_LARGE") {
      return reply(res, 413, { error: "Ukuran gambar maksimal 4 MB." });
    }
    console.error("QRIS upload failed", error);
    return reply(res, 500, { error: "QRIS gagal disimpan ke Blob." });
  }
}
