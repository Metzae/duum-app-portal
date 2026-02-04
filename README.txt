# Duum.io — DuumGPT Portal (MVP PWA)

This is a tiny "smartphone app" that is essentially a web portal:
- pick 1..N images (screenshots/photos)
- POST them to your local DuumGPT server
- show structured JSON output

## Run locally

### Option A: VS Code Live Server
Open folder -> right-click index.html -> Open with Live Server

### Option B: Python
python -m http.server 8080

Open: http://localhost:8080

## API expectation
- GET /health -> 200 OK
- POST /api/ingest/items (multipart/form-data, files=1..N)

Fields:
- files (repeated)
- mode (beginner|no_fluff|deep_dive)
- context (JSON string)

If your server uses a different route, change it in the UI dropdown.
