#!/usr/bin/env python3
"""Generate the deterministic nine-page PDF used to verify extraction limits."""
from pathlib import Path
import sys


def page_limit_pdf(pages=9):
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    kids = []
    for page in range(1, pages + 1):
        page_number = len(objects) + 1
        kids.append(f"{page_number} 0 R")
        content_number = page_number + 1
        objects.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_number} 0 R >>".encode())
        lines = [f"pdf-limit-page-{page:02d}-marker", f"Deterministic PDF acceptance page {page} of {pages}."]
        lines += [f"Line {line}: public document text must remain inside the selected page range." for line in range(1, 9)]
        content = ("BT /F1 11 Tf 72 740 Td " + " 0 -18 Td ".join("(" + line + ") Tj" for line in lines) + " ET").encode()
        objects.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
    objects[1] = f"<< /Type /Pages /Count {pages} /Kids [{' '.join(kids)}] >>".encode()
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{i} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    output.extend(b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:]))
    output.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(output)


if __name__ == "__main__":
    destination = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("pdf-page-limits.pdf")
    destination.write_bytes(page_limit_pdf())
