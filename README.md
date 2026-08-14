# Clara — Voz ao vivo

Aplicativo web de comunicação assistida para ajudar um médico com alteração de
dicção a conduzir consultas. A Clara reconhece a fala, permite corrigir a
pergunta e a reproduz com voz clara para o paciente.

## Recursos

- reconhecimento de fala em português do Brasil;
- reprodução da pergunta com síntese de voz;
- perguntas rápidas de anamnese;
- treinamento organizado por etapas da consulta médica;
- memória local das correções do usuário;
- gravação de áudio associada ao texto correto;
- exportação da base de voz em ZIP;
- interface responsiva e acessível.

As correções e gravações ficam somente no navegador do usuário. O repositório e
a hospedagem não recebem os áudios das consultas.

## Executar localmente

Requer Node.js 22 ou mais recente.

```bash
npm install
npm run dev
```

Abra `http://localhost:3000` no Chrome ou Edge e permita o acesso ao microfone.

## Verificação

```bash
npm run lint
npm test
```

## Hospedar no Netlify

O projeto usa Next.js e inclui o arquivo `netlify.toml`. No Netlify:

1. Selecione **Add new project → Import an existing project**.
2. Conecte o repositório `DrLucasPCD/Voz-ao-vivo`.
3. Confirme o comando de build `npm run build` e a pasta `.next`.
4. Publique o projeto.

O Netlify detecta o Next.js automaticamente. Não é necessário fixar uma versão
do adaptador do Netlify.

## Privacidade clínica

Este protótipo é uma ferramenta de comunicação e não fornece diagnóstico ou
conduta médica. Evite incluir dados identificáveis do paciente nas frases de
treinamento. Em uso clínico, valide os requisitos de privacidade, segurança e
conformidade aplicáveis à sua instituição.
