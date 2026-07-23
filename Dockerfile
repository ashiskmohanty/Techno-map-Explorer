# PS Process Explorer — container image (SDK-free HTTPS/OData SAP path)
FROM python:3.12-slim

WORKDIR /app

# install deps first for better layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# app code (data.json / Excel are provided at runtime via a mounted volume,
# or bake them in by removing them from .dockerignore)
COPY . .

# waitress serves on this port; Azure App Service / Container Apps set PORT too
ENV PSPE_HOST=0.0.0.0 \
    PSPE_PORT=8000
EXPOSE 8000

# generates data.json from Excel if missing, then serves via waitress
CMD ["python", "serve.py"]
