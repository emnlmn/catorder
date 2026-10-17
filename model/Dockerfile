# Prediction service: model/serve.py with the weights trained on the AMD GPU, inference on CPU.
# docker build -t catorder-predict model && docker run -p 8077:8077 catorder-predict
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir numpy
COPY model.py serve.py ./
COPY weights weights
ENV PORT=8077 MODEL_DEVICE=cpu
EXPOSE 8077
CMD ["python", "serve.py"]
