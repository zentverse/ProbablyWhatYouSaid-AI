import json
import os
from pathlib import Path

import requests


FILE_PATH = Path(
    r"C:\Users\ROG\Dropbox\My PC (LAPTOP-Q8OTL9NR)\Downloads\Sweden Student Visa තනියම Apply කරමු _ How to apply student visa for Sweden [wg-lYtOiHV4].mp3"
)
API_BASE_URL = os.getenv("API_BASE_URL", "http://127.0.0.1:8100")
PROVIDER = os.getenv("PROVIDER", "speech")
LANGUAGE = os.getenv("LANGUAGE", "")


with FILE_PATH.open("rb") as f:
    response = requests.post(
        f"{API_BASE_URL}/transcribe",
        files={"file": (FILE_PATH.name, f)},
        data={"provider": PROVIDER, "language": LANGUAGE},
        timeout=900,
    )

print("Status:", response.status_code)
try:
    print(json.dumps(response.json(), ensure_ascii=False, indent=2))
except Exception:
    print("Raw text:", response.text)
