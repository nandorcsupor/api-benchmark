# Build context is the repo root: the image needs data/products.json too.
# Measured on this exact image. The bare 3.13-slim alias follows Debian's default
# suite and flips to the next stable when it lands, which would change glibc and
# therefore the memory columns.
FROM python:3.13.16-slim-trixie
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY servers/python-fastapi/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY servers/python-fastapi/app.py ./
COPY data/products.json /app/data/products.json
EXPOSE 8080
# One worker: this benchmark measures per-core efficiency.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", \
     "--workers", "1", "--no-access-log", "--log-level", "warning"]
