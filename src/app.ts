import express from 'express';

const app = express();

app.disable('x-powered-by');

app.get('/', (_request, response) => {
  response.status(200).json({
    success: true,
    message: 'EventGate API is running',
    data: {
      service: 'EventGate',
      version: 'v1',
    },
  });
});

export { app };
