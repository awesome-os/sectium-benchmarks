// Zero-V8 ECMAScript compute + TFB JSON/plaintext payload formatter benchmark
// Runs directly on E:\awesome-os\sections\b8g-es\dist\sectium-es.exe (dup_v8=0 B)

function formatPlaintext(msg) {
  return (
    "HTTP/1.1 200 OK\r\n" +
    "Server: Sectium-ES\r\n" +
    "Content-Type: text/plain\r\n" +
    "Content-Length: " + msg.length + "\r\n" +
    "Connection: keep-alive\r\n\r\n" +
    msg
  );
}

function formatJson(msg) {
  let body = '{"message":"' + msg + '"}';
  return (
    "HTTP/1.1 200 OK\r\n" +
    "Server: Sectium-ES\r\n" +
    "Content-Type: application/json\r\n" +
    "Content-Length: " + body.length + "\r\n" +
    "Connection: keep-alive\r\n\r\n" +
    body
  );
}

function dispatch(route) {
  if (route === "/plaintext") {
    return formatPlaintext("Hello, World!");
  }
  if (route === "/json") {
    return formatJson("Hello, World!");
  }
  return "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nNot Found";
}

let iterations = 10000;
let totalBytes = 0;
let plaintextCount = 0;
let jsonCount = 0;

let t0 = sys.clockNs();
for (let i = 0; i < iterations; i += 1) {
  let resp = "";
  if (i % 2 === 0) {
    resp = dispatch("/plaintext");
    plaintextCount += 1;
  } else {
    resp = dispatch("/json");
    jsonCount += 1;
  }
  totalBytes += resp.length;
}
let t1 = sys.clockNs();

let elapsedMs = (t1 - t0) / 1000000;
console.log(
  "sectium-es tfb-bench iterations=" + iterations +
  " plaintext=" + plaintextCount +
  " json=" + jsonCount +
  " total_bytes=" + totalBytes +
  " elapsed_ms=" + elapsedMs +
  " dup_v8=0B"
);
