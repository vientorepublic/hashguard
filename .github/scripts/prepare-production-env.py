#!/usr/bin/env python3
"""Add the adaptive risk secret once; preserve existing credentials and policy."""
import os
from pathlib import Path
import re
import secrets
import sys


def prepare(path: Path) -> bool:
    if not path.is_file() or path.is_symlink():
        raise ValueError('A regular production .env file is required')
    text = path.read_text()
    values = {}
    for line in text.splitlines():
        match = re.match(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$', line)
        if match:
            value = match[2]
            if value.startswith(('"', "'")) and value.endswith(value[0]):
                value = value[1:-1]
            else:
                value = value.split(' #', 1)[0].rstrip()
            values[match[1]] = value
    if not any(values.get(key) for key in ('POW_TOKEN_PRIVATE_KEY_PEM', 'POW_TOKEN_PRIVATE_KEY_BASE64')):
        raise ValueError('Configure the persistent proof-token signing key before deployment')
    if 'POW_RISK_KEY_SECRET' in values:
        if len(values['POW_RISK_KEY_SECRET']) < 32:
            raise ValueError('Existing POW_RISK_KEY_SECRET must have at least 32 characters')
        return False
    # Only append a missing key. Never replace existing signing/risk keys.
    with path.open('a') as handle:
        handle.write(('' if text.endswith('\n') else '\n') + 'POW_RISK_KEY_SECRET=' + secrets.token_hex(32) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    return True


if __name__ == '__main__':
    try:
        changed = prepare(Path(sys.argv[1]))
        print('Production credentials preserved; adaptive risk secret ' + ('initialized' if changed else 'already configured'))
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
