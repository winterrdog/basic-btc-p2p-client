import { createHash } from "node:crypto";
import { createConnection } from "node:net";

main().catch((err) => console.error("unknown error occured", err));

// ===============
// implementation
// ===============

async function main() {
  // const PORT = 18_332;
  const PORT = 8_333;
  const socket = connToBtcNode();
  await waitForSocketReadiness();

  // 1. send version msg. u cannot proceed without it
  console.log("+ sending version message to remote peer BTC node");
  await sendVersionMessage();

  // 2. receive version msg from remote peer BTC node
  console.log("+ waiting to receive version message from remote peer BTC node");
  await readVersionMsg();

  // 3. send verack immediately after receiving version
  console.log("+ sending my version ack message to remote peer BTC node");
  await sendMyVerAckMsg();

  // 4. receive version ack msg (verack) from remote peer BTC node
  console.log(
    "+ waiting to receive version ack message from remote peer BTC node"
  );
  await Promise.race([
    readVerAckMsg(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout waiting for verack")), 10000)
    ),
  ]);

  console.log("+ Handshake complete! 🎉");

  // =======
  // HELPERS
  // =======

  async function sendMyVerAckMsg() {
    const msg = buildVersionAckMsg();
    await asyncSockWrite(msg);
  }

  async function readVerAckMsg() {
    const { magicBytes, cmd, checksum, size, payload } = await readBtcNodeMsg();

    console.log(`
VERSION ACK MSG HEADER:
magic bytes: ${magicBytes.toString("hex")},
command: ${cmd.toString("ascii")},
size: ${size},
checksum: ${checksum.toString("hex")}
      `);

    console.log(`
VERSION ACK MSG PAYLOAD:
payload: ${!!size ? payload.toString("hex") : "none"})}
      `);
  }

  async function readVersionMsg() {
    const { magicBytes, cmd, checksum, size, payload } = await readBtcNodeMsg();

    console.log(`
> VERSION MSG HEADER:
> magic bytes: ${magicBytes.toString("hex")},
> command: ${cmd.toString("ascii")},
> size: ${size},
> checksum: ${checksum.toString("hex")}
      `);

    console.log(`
> VERSION MSG PAYLOAD:
> payload: ${payload.toString("hex")}
      `);
  }

  async function readBtcNodeMsg() {
    // read header
    const magicBytes = await readNBytes(4);
    const cmd = await readNBytes(12);
    const size = (await readNBytes(4)).readUint32LE(0);
    const checksum = await readNBytes(4);

    // read payload
    const payload = await readNBytes(size);

    return { magicBytes, cmd, size, checksum, payload };
  }

  function readNBytes(n: number) {
    return new Promise<Buffer>(function (resolve, reject) {
      let totalRead = 0;
      let chunks: Buffer[] = [];
      let isResolved = false;

      socket.on("error", onError);
      socket.on("close", onClose);

      tryRead();

      // =====
      // helpers
      // =====

      function cleanup() {
        socket.removeListener("readable", tryRead);
        socket.removeListener("error", onError);
        socket.removeListener("close", onClose);
      }
      function onError(err: Error) {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          reject(err);
        }
      }
      function onClose() {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          reject(new Error("Socket closed while reading"));
        }
      }
      function tryRead() {
        const remainingBytes = n - totalRead;
        const data: Buffer | null = socket.read(remainingBytes);

        if (data) {
          chunks.push(data);
          totalRead += data.length;
          if (totalRead >= n) {
            if (!isResolved) {
              isResolved = true;
              cleanup();
              const result = Buffer.concat(chunks);
              return resolve(result.subarray(0, n));
            }
          }
        }

        // only add listeners if we haven't resolved yet
        if (!isResolved) {
          socket.once("readable", tryRead);
        }
      }
    });
  }

  function convertToHex(n: number): string {
    return n.toString(16);
  }

  function formatDataSize(data: string, size: number): string {
    return data.padStart(size * 2, "0");
  }

  function reverseBytes(bytes: string): Buffer {
    return Buffer.from(bytes, "hex").reverse();
  }

  function asciiToHex(s: string): string {
    return Array.from(s)
      .map(function (char) {
        //convert each char -> char code -> hex (always 2 digits)
        return convertToHex(char.charCodeAt(0)).padStart(2, "0");
      })
      .join("")
      .padEnd(24, "0"); //pad right with zeros to 24 hex chars (12 bytes)
  }

  function checksum(data: Buffer): Buffer {
    // double hash in order to get checksum
    const h1 = createHash("sha256").update(data).digest();
    const h2 = createHash("sha256").update(h1).digest();

    // return the first 4 bytes
    return Buffer.from(h2.subarray(0, 4));
  }

  function genVersionMsgPayload() {
    const version = Buffer.alloc(4);
    version.writeInt32LE(70014); // little-endian

    const services = Buffer.alloc(8);
    services.writeBigUInt64LE(BigInt(0));

    const time = Buffer.alloc(8);
    time.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)));

    // addr for receiver
    const remoteServices = Buffer.alloc(8);
    const remotePort = Buffer.alloc(2);
    remoteServices.writeBigUInt64LE(0n);
    remotePort.writeUInt16BE(PORT);
    const addrRecv = Buffer.concat([
      remoteServices,
      Buffer.from("00000000000000000000ffffa27845b6", "hex"),
      // Buffer.from("00000000000000000000ffff7f000001", "hex"),
      remotePort,
    ]);

    // NOTE
    // addr for sender
    // Field can be ignored. This used to be the network address of the node emitting this message,
    // but most P2P implementations send 26 dummy bytes. The "services" field of the address would
    // also be redundant with the second field of the version message.

    const addrSender = Buffer.alloc(26);

    const userAgent = Buffer.from("00", "hex");

    // const startHeight = Buffer.alloc(4);
    // startHeight.writeInt32LE(500);

    const nonce = Buffer.alloc(8);
    nonce.writeBigUInt64LE(
      BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
    );

    const lastBlock = Buffer.alloc(4);
    lastBlock.writeUInt32LE(0);

    const relay = Buffer.from([0x01]);

    // be careful with the ordering too when combining pieces of data
    const payload = Buffer.concat([
      version,
      services,
      time,
      addrRecv,
      addrSender,
      nonce,
      userAgent,
      lastBlock,
      // startHeight,
      relay,
    ]);

    return payload;
  }

  function genVersionMsgHdr(payload: Buffer) {
    // const magicBytes = Buffer.alloc(4);
    // magicBytes.writeUInt32LE(0x0709110b);
    const magicBytes = Buffer.from("f9beb4d9", "hex");

    const cmd = Buffer.from(asciiToHex("version"), "hex");

    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);

    const chkSum = checksum(payload);

    // be careful with the ordering too when combining pieces of data
    const header = Buffer.concat([magicBytes, cmd, size, chkSum]);
    return header;
  }

  function buildVersionMsg() {
    // each msg has a header and a payload.
    const payload = genVersionMsgPayload();
    const header = genVersionMsgHdr(payload);
    return Buffer.concat([header, payload]);
  }

  async function sendVersionMessage() {
    const versionMsg = buildVersionMsg();
    await asyncSockWrite(versionMsg);
  }

  function genVersionAckMsgHdr(payload: Buffer) {
    // const magicBytes = Buffer.alloc(4);
    // magicBytes.writeUInt32LE(0x0709110b);
    const magicBytes = Buffer.from("f9beb4d9", "hex");

    const cmd = Buffer.from(asciiToHex("verack"), "hex");

    const size = Buffer.alloc(4);
    size.writeUInt32LE(payload.length);

    const chkSum = checksum(payload);

    //     console.log(`
    // VERSION ACK:
    // magic bytes: ${magicBytes.toString("hex")},
    // command: verack,
    // size: ${size.readUint32LE(0)},
    // checksum: ${chkSum.toString("hex")},
    // payload: ${payload.toString("hex")}`);

    // be careful with the ordering too when combining pieces of data
    const header = Buffer.concat([magicBytes, cmd, size, chkSum]);
    return header;
  }

  function buildVersionAckMsg() {
    const payload = Buffer.alloc(0); // verack msgs lack a payload
    const header = genVersionAckMsgHdr(payload);
    return Buffer.concat([header, payload]);
  }

  function asyncSockWrite(data: Buffer) {
    return new Promise<void>(function (resolve, reject) {
      socket.write(data, function (err) {
        return err ? reject(err) : resolve();
      });
    });
  }

  function connToBtcNode() {
    const ip = "162.120.69.182"; // my local node
    // const ip = "127.0.0.1"; // my local node
    const socket = createConnection(
      { port: PORT, host: ip, family: 4 },
      function onConnection() {
        console.log(`+ connected sucessfuly to btc node at, ${ip}:${PORT}`);
      }
    );

    socket.on("error", (err) => {
      console.error("Socket error:", err);
    });
    socket.on("close", () => {
      console.log("Socket closed by remote peer");
    });

    return socket;
  }

  function waitForSocketReadiness() {
    return new Promise<void>(function (resolve) {
      socket.once("ready", function () {
        resolve();
      });
    });
  }
}
