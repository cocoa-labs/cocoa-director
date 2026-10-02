import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractMediaArchive } from "@/lib/server/media-archive";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const fixtures = {
  "valid": "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AKZdADkZSdrpOaPtMnZApgrcMXHNVwb4wZosep/NscE+dTw8yP3Xnw7JGuiNL1Vh6cG61f+c9KrCBy6IP56beDtDIBXo2N+ZM6+lhGDgb/TSGRRYtM81YyZoWVPaPF9BFxznaeNkIoe31RllNoBfePXKUGRZUd+KMFfTGi1+bS2+v8wIG04d+rHqH+qULZ3T1aT/+89Lwdi3v3pb8xd7AA7RlVmjMdbaoAAAAAAbUsRbakdp6wABwgGAUAAAWdrwI7HEZ/sCAAAAAARZWg==",
  "symlink": "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/ALBdADkZSdrpOaPtMnZApgrcMXHNVwb4wZosep/NscE+eAzGehkQpJWSZqs+PCxuqnHdwZPKDAlbt+mVHRYwhHm5SUTO6O/f7nt4ls+eHJSgnMmujfOHrrap/vMCRU+C35tXKuZRom/VgtDkObNkcAPQ/tuYgltOE6lJ6JTJoTNcQtN2JUWhHrgO6PEmCKssg43N9D2SKyY1dnXQM3JxC+blNxTHKK21lueAb3pFdc3qeLsAACWYNTEKiqRBAAHMAYBQAAApu/oZscRn+wIAAAAABFla",
  "missing": "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AJZdADkZSdrpOaPtMnZApgrcMXHNVwb4wZosep/NscE+dTw8yP3Xnw7JGuiNL1Vh6cG61f+c9KrCBy6IP56beDtDIBXo2N+ZM6+lhGDgb/TSGRRYtM81YyZfHrRSVlvtMcwdCq/c7ObWyHX9whsmtKEBZpVsoTyNMtRaCyaJXAze8cweyQHrFt2V1r+ENIOLGmAk++M9H/yswAAAALMVx2q6tYCxAAGyAYBQAACY19IoscRn+wIAAAAABFla"
};
async function prepare(kind: keyof typeof fixtures) {
  const directory = await mkdtemp(join(tmpdir(), "cocoa-archive-test-")); directories.push(directory);
  const archive = join(directory, "fixture.tar.xz");
  await writeFile(archive, Buffer.from(fixtures[kind], "base64"));
  return { directory, archive, output: join(directory, "output") };
}
describe("portable verified-media extraction", () => {
  it("extracts only the two allowed executables, ignoring traversal entries", async () => {
    const { directory, archive, output } = await prepare("valid");
    await extractMediaArchive(archive, output, "release");
    expect(await readFile(join(output, "bin/ffmpeg"), "utf8")).toBe("synthetic tool fixture");
    expect(await readFile(join(output, "bin/ffprobe"), "utf8")).toBe("synthetic tool fixture");
    await expect(readFile(join(directory, "escaped"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects executable symlinks", async () => {
    const { archive, output } = await prepare("symlink");
    await expect(extractMediaArchive(archive, output, "release")).rejects.toThrow("Invalid media executable");
  });
  it("requires both executables", async () => {
    const { archive, output } = await prepare("missing");
    await expect(extractMediaArchive(archive, output, "release")).rejects.toThrow("missing required executables");
  });
});
