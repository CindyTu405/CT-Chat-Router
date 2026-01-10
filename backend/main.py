from fastapi import FastAPI
from sqlmodel import SQLModel

app = FastAPI()

@app.get("/")
def read_root():
    return {"Hello": "World"}

@app.get("/health")
def health():
    return {"db_status": "Not connected yet (TO DO)"}
