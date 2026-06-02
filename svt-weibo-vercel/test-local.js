const handler = require("./api/weibo");

function call(query) {
  return new Promise((resolve, reject) => {
    const req = { method: "GET", query };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(data) { resolve({ status: this.statusCode, headers: this.headers, data }); },
      end() { resolve({ status: this.statusCode, headers: this.headers, data: null }); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

(async () => {
  const page1 = await call({ uid: "6409560260", page: "1" });
  console.log("page1", {
    status: page1.status,
    ok: page1.data.ok,
    cards: page1.data.data?.cards?.length || 0,
    first: page1.data.data?.cards?.[0]?.mblog?.text?.slice(0, 50),
  });

  const many = await call({ uid: "6409560260", count: "20", maxPages: "4" });
  console.log("count20", {
    status: many.status,
    ok: many.data.ok,
    cards: many.data.data?.cards?.length || 0,
    error: many.data.error,
  });
})();
