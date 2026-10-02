import { installMediaTools, findMediaTools } from "../src/lib/server/media-tools.ts";
try {
  const tools = await findMediaTools() ?? await installMediaTools();
  console.log(`FFmpeg: ${tools.ffmpeg}\nffprobe: ${tools.ffprobe}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
