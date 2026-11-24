#!/usr/bin/env python3
"""Check an OpenAI-compatible chat-completions API without printing the API key."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
DEFAULT_MODEL = "glm-4-flash"


def redact(text: str, api_key: str) -> str:
    if api_key:
        text = text.replace(api_key, "[REDACTED]")
    return re.sub(
        r"(?i)(bearer\s+)[A-Za-z0-9._~+/-]+=*",
        r"\1[REDACTED]",
        text,
    )


def read_error_body(error: HTTPError, api_key: str) -> str:
    body = error.read(16_384).decode("utf-8", errors="replace")
    try:
        body = json.dumps(json.loads(body), ensure_ascii=False)
    except json.JSONDecodeError:
        pass
    return redact(body, api_key)[:2_000]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Send a minimal request to an OpenAI-compatible LLM API."
    )
    parser.add_argument(
        "--base-url",
        default=os.getenv("LLM_BASE_URL", DEFAULT_BASE_URL),
        help=f"API base URL (default: {DEFAULT_BASE_URL})",
    )
    parser.add_argument(
        "--model",
        default=os.getenv("LLM_MODEL", DEFAULT_MODEL),
        help=f"Model name (default: {DEFAULT_MODEL})",
    )
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args()

    api_key =  'f4783583b7c445f3bcdb4c5ddc8b8bae.uAzqzWYJSZ49GXGn'
    if not api_key:
        print(
            "Missing API key. Set LLM_API_KEY or ZHIPUAI_API_KEY; "
            "do not put the key in this file or share it in chat.",
            file=sys.stderr,
        )
        return 2
    if args.timeout <= 0:
        print("--timeout must be greater than zero.", file=sys.stderr)
        return 2

    base_url = args.base_url.rstrip("/")
    parsed_url = urlparse(base_url)
    if (
        parsed_url.scheme != "https"
        or not parsed_url.netloc
        or parsed_url.username
        or parsed_url.password
        or parsed_url.query
        or parsed_url.fragment
    ):
        print(
            "Invalid base URL: use an HTTPS API base URL without credentials, "
            "query parameters, or a fragment.",
            file=sys.stderr,
        )
        return 2

    endpoint = f"{base_url}/chat/completions"
    payload = {
        "model": args.model,
        "messages": [
            {"role": "user", "content": "Reply with exactly: API connection OK"}
        ],
        "temperature": 0.01,
    }
    request = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    print(f"Endpoint: {endpoint}")
    print(f"Model: {args.model}")
    try:
        with urlopen(request, timeout=args.timeout) as response:
            response_body = response.read(65_536).decode("utf-8", errors="replace")
            print(f"HTTP status: {response.status}")
    except HTTPError as error:
        print(f"HTTP status: {error.code}")
        details = read_error_body(error, api_key)
        if details:
            print(f"Service response: {details}")
        if error.code == 401:
            print(
                "Check that the key is active, belongs to this provider/account, "
                "and is copied without extra spaces."
            )
        return 1
    except URLError as error:
        print(f"Connection failed: {redact(str(error.reason), api_key)}", file=sys.stderr)
        return 1
    except TimeoutError:
        print(f"Request timed out after {args.timeout:g} seconds.", file=sys.stderr)
        return 1

    try:
        result = json.loads(response_body)
        content = result["choices"][0]["message"]["content"]
    except (json.JSONDecodeError, KeyError, IndexError, TypeError):
        print(f"Invalid chat-completions response: {redact(response_body, api_key)[:2_000]}")
        return 1

    if not isinstance(content, str):
        print("Invalid response: choices[0].message.content is not a string.")
        return 1
    print(f"Reply: {redact(content, api_key)[:1_000]}")
    print("API request succeeded.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
