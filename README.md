# Clara — voz assistida

Protótipo web de comunicação assistida em português do Brasil.

## Recursos atuais

- reconhecimento de fala pelo microfone;
- texto editável antes da reprodução;
- síntese de voz em português;
- memória local das correções do usuário;
- modo de treinamento com áudio e transcrição correta;
- frases rápidas e reprodução automática opcional.

As correções e amostras de treinamento ficam armazenadas somente no navegador
do usuário nesta primeira versão.

## Desenvolvimento

Requer Node.js `>=22.13.0`.

```bash
npm install
npm run dev
npm test
```

O reconhecimento de fala funciona melhor no Chrome ou Edge. O navegador deve
ter permissão para acessar o microfone.
