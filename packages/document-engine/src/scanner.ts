import { connect } from "node:net";

/**
 * Antivirus scanning. ClamAV (clamd) is optional on a small VPS because it
 * needs ~1.5 GB RAM; when it is not configured, files are marked SKIPPED (never
 * reported as "clean"). Magic-byte validation and PDF active-content rejection
 * still apply to every upload.
 */
export type ScanResult = { status: "CLEAN" } | { status: "INFECTED"; signature: string } | { status: "SKIPPED" } | { status: "ERROR"; error: string };

export interface VirusScanner {
  scan(data: Buffer): Promise<ScanResult>;
}

export class NoopScanner implements VirusScanner {
  async scan(): Promise<ScanResult> {
    return { status: "SKIPPED" };
  }
}

/** Minimal clamd client using the INSTREAM command (chunked, length-prefixed). */
export class ClamAVScanner implements VirusScanner {
  constructor(
    private readonly host: string,
    private readonly port = 3310,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (r: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(this.timeoutMs, () => done({ status: "ERROR", error: "clamd timeout" }));
      socket.on("error", (e) => done({ status: "ERROR", error: e.message }));
      socket.on("data", (c) => chunks.push(c));
      socket.on("end", () => {
        const reply = Buffer.concat(chunks).toString("utf8").replace(/\0/g, "").trim();
        if (/: OK$/.test(reply)) done({ status: "CLEAN" });
        else if (/FOUND$/.test(reply)) done({ status: "INFECTED", signature: reply.replace(/^stream: /, "").replace(/ FOUND$/, "") });
        else done({ status: "ERROR", error: reply || "empty clamd reply" });
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        const CHUNK = 64 * 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
          const part = data.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
      });
    });
  }
}
