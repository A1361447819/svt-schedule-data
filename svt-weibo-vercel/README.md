# SVT Weibo Backend

Vercel Node backend for the SVT calendar Weibo extraction feature.

Endpoints:

- `/api/weibo?page=1`
- `/api/weibo?count=30`
- `/api/weibo?date=2026-06-01&count=80&maxPages=12`

The backend returns Weibo-compatible JSON cards so the existing calendar can reuse its current parser.
