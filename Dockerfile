FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY pyproject.toml README.md ./
COPY market_update ./market_update
COPY watchlist.txt ./
RUN pip install --upgrade pip && pip install .
ENV PORT=8000 MU_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8000
CMD ["sh", "-c", "uvicorn market_update.server:app --host 0.0.0.0 --port ${PORT}"]
