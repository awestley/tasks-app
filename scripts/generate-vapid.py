"""Write a new private Web Push configuration without printing keys or overwriting files."""

import argparse
import base64
import os
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

parser = argparse.ArgumentParser()
parser.add_argument("--subject", required=True, help="Contact mailto: address or HTTPS URL")
parser.add_argument("--output", default="api/.env.push", help="New private environment file")
args = parser.parse_args()
if not args.subject.startswith(("mailto:", "https://")) or any(c in args.subject for c in "\n\r\"' "):
    parser.error("Use a mailto: contact address or an HTTPS URL without whitespace or quotes")
key = ec.generate_private_key(ec.SECP256R1())


def encode(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


private = encode(
    key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
)
public = encode(
    key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
)
path = Path(args.output)
fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
with os.fdopen(fd, "w") as output:
    output.write(f"VAPID_PUBLIC_KEY={public}\nVAPID_PRIVATE_KEY={private}\nVAPID_SUBJECT={args.subject}\n")
print(f"Wrote private Web Push configuration to {path}. Keep this key pair stable across deployments.")
