FROM python:3.14-slim
WORKDIR /app
COPY --chmod=0444 serve_fixtures.py /app/
USER 65534:65534
EXPOSE 8765 8766
CMD ["python", "-u", "serve_fixtures.py"]

COPY --chmod=0444 fixtures/sample.pdf /app/sample.pdf

COPY --chmod=0444 fixtures/pdf-page-limits.pdf /app/pdf-page-limits.pdf
COPY --chmod=0444 fixtures/quarterly-results.html /app/quarterly-results.html
COPY --chmod=0444 fixtures/code-fidelity.html /app/code-fidelity.html
