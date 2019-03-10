const alexa = require('ask-sdk');
const constants = require('./constants');

/* CUSTOM AND AUDIO INTERFACE INTENT */

const StartPlaybackHandler = {
  canHandle(handlerInput) {
    const { request } = handlerInput.requestEnvelope;

    return request.type === 'IntentRequest' && request.intent.name === 'PlaySongByName'
  },
  handle(handlerInput) {
    return controller.play(handlerInput, true);
  },
};

const ResumePlaybackHandler = {
  canHandle(handlerInput) {
    const { request } = handlerInput.requestEnvelope;

    if (request.type === 'PlaybackController.PlayCommandIssued') {
      return true;
    }

    return request.type === 'IntentRequest' && request.intent.name === 'AMAZON.ResumeIntent'
  },
  handle(handlerInput) {
    return controller.play(handlerInput);
  },
};

const PausePlaybackHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return playbackInfo.inPlaybackSession && request.type === 'IntentRequest'
    && (request.intent.name === 'AMAZON.StopIntent'
     || request.intent.name === 'AMAZON.CancelIntent'
     || request.intent.name === 'AMAZON.PauseIntent');
  },
  handle(handlerInput) {
    return controller.stop(handlerInput);
  },
};

/* AUDIO PLAYER EVENTS HANDLERS */

const AudioPlayerEventHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type.startsWith('AudioPlayer.');
  },
  async handle(handlerInput) {
    const { requestEnvelope, attributesManager, responseBuilder } = handlerInput;
    const audioPlayerEventName = requestEnvelope.request.type.split('.')[1];
    const { playbackSetting, playbackInfo } = await attributesManager.getPersistentAttributes();

    switch (audioPlayerEventName) {
      case 'PlaybackStarted':
        playbackInfo.token = getToken(handlerInput);
        playbackInfo.index = await getIndex(handlerInput);
        playbackInfo.inPlaybackSession = true;
        playbackInfo.hasPreviousPlaybackSession = true;
        break;
      case 'PlaybackFinished':
        playbackInfo.inPlaybackSession = false;
        playbackInfo.hasPreviousPlaybackSession = false;
        playbackInfo.nextStreamEnqueued = false;
        break;
      case 'PlaybackStopped':
        playbackInfo.token = getToken(handlerInput);
        playbackInfo.index = await getIndex(handlerInput);
        playbackInfo.offsetInMilliseconds = getOffsetInMilliseconds(handlerInput);
        break;
      case 'PlaybackNearlyFinished':
      {
        if (playbackInfo.nextStreamEnqueued) {
          break;
        }

        const enqueueIndex = (playbackInfo.index + 1) % constants.hymns.length;

        if (enqueueIndex === 0 && !playbackSetting.loop) {
          break;
        }

        playbackInfo.nextStreamEnqueued = true;

        const enqueueToken = playbackInfo.playOrder[enqueueIndex];
        const playBehavior = 'ENQUEUE';
        const song = constants.hymns[playbackInfo.playOrder[enqueueIndex]];
        const expectedPreviousToken = playbackInfo.token;

        const offsetInMilliseconds = 0;

        responseBuilder.addAudioPlayerPlayDirective(
          playBehavior,
          song.url,
          enqueueToken,
          offsetInMilliseconds,
          expectedPreviousToken,
        );
        break;
      }
      case 'PlaybackFailed':
        playbackInfo.inPlaybackSession = false;
        console.log('Playback Failed : %j', handlerInput.requestEnvelope.request.error);
        return;
      default:
        throw new Error('Should never reach here!');
    }

    return responseBuilder.getResponse();
  },
};

/* CONTROLLER */

const controller = {
  async play(handlerInput, custom = false) {
    const blackList = [41, 46, 137, 172, 204];
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { playOrder, offsetInMilliseconds, index } = playbackInfo;
    const playBehavior = 'REPLACE_ALL';
    let hymn;
    let token;

    if (custom) {

      if (!handlerInput.requestEnvelope.request.intent.slots.NameOrNumber.value) {
        const speechText = `Lo siento, ese himno no existe, prueba pidiendo otro himno por número o nombre`;
        const repromptText = 'prueba pidiendo otro himno por número o nombre';
    
        return handlerInput.responseBuilder
          .speak(speechText)
          .reprompt(repromptText)
          .withSimpleCard('', speechText)
          .getResponse();
      }

      hymn = await parseSlots(handlerInput);

      if (blackList.includes(hymn.number)) {
        const speechText = `El himno ${hymn.number} no puede ser reproducido por derechos de autor, prueba pidiendo otro himno por número o nombre`;
        const repromptText = 'prueba pidiendo otro himno por número o nombre';
    
        return handlerInput.responseBuilder
          .speak(speechText)
          .reprompt(repromptText)
          .withSimpleCard('', speechText)
          .getResponse();
      }
  
      if (hymn.notFound) {
        const speechText = `No se encontro el himno ${hymn.slot}, prueba pidiendo otro himno por número o nombre`;
        const reprompt = 'prueba pidiendo otro himno por número o nombre';
  
        return handlerInput.responseBuilder
        .speak(speechText)
        .reprompt(reprompt)
        .withSimpleCard('', speechText)
        .getResponse();
      }

      token = playOrder[hymn.number - 1];
      playbackInfo.nextStreamEnqueued = false;
      playbackInfo.index = hymn.number - 1;

    } else {

      token = playOrder[index];
      hymn = constants.hymns[playOrder[index]];

      // jump to next if its not available
      if (blackList.includes(hymn.number)) {
        return controller.playNext(handlerInput);
      }
    }

    playbackInfo.nextStreamEnqueued = false;

    handlerInput.responseBuilder
      .speak(hymn.name)
      .withShouldEndSession(true)
      .addAudioPlayerPlayDirective(playBehavior, hymn.url, token, offsetInMilliseconds, null);

    if (await canThrowCard(handlerInput)) {
      const cardTitle = `Reproduciendo himno número ${hymn.number}`;
      const cardContent = `${hymn.name}`;
      handlerInput.responseBuilder.withSimpleCard(cardTitle, cardContent);
    }

    return handlerInput.responseBuilder.getResponse();
  },
  async playNext(handlerInput) {
    const {
      playbackInfo,
      playbackSetting,
    } = await handlerInput.attributesManager.getPersistentAttributes();
    const nextIndex = (playbackInfo.index + 1) % constants.hymns.length;

    if (nextIndex === 0 && !playbackSetting.loop) {
      return handlerInput.responseBuilder
        .speak('Has llegado al final de la lista')
        .addAudioPlayerStopDirective()
        .getResponse();
    }

    playbackInfo.index = nextIndex;
    playbackInfo.offsetInMilliseconds = 0;
    playbackInfo.playbackIndexChanged = true;

    return this.play(handlerInput);
  },
  async playPrevious(handlerInput) {
    const {
      playbackInfo,
      playbackSetting,
    } = await handlerInput.attributesManager.getPersistentAttributes();
    let previousIndex = playbackInfo.index - 1;

    if (previousIndex === -1) {
      if (playbackSetting.loop) {
        previousIndex += constants.hymns.length;
      } else {
        return handlerInput.responseBuilder
          .speak('Has llegado al inicio de la lista')
          .addAudioPlayerStopDirective()
          .getResponse();
      }
    }

    playbackInfo.index = previousIndex;
    playbackInfo.offsetInMilliseconds = 0;
    playbackInfo.playbackIndexChanged = true;

    return this.play(handlerInput);
  },
  stop(handlerInput) {
    return handlerInput.responseBuilder
      .addAudioPlayerStopDirective()
      .getResponse();
  },
};

/* HELPERS */

async function parseSlots(handlerInput){
  const slot = handlerInput.requestEnvelope.request.intent.slots.NameOrNumber.value;
  let found;

  if (isNaN(slot)) {
    found = constants.hymns.find(el => {
       return cleanString(el.name) === cleanString(slot)
    })
  } else {
    found = constants.hymns.find(el => el.number === parseInt(slot, 10));
  }

  if (!found) {
    found = { slot, notFound: true }
  }

  return found
}

function cleanString(str) {
  return str
  .replace(/[^\w]/g, "")
  .toLowerCase()
  .split("")
  .sort()
  .join("");
}

function getToken(handlerInput) {
  // Extracting token received in the request.
  return handlerInput.requestEnvelope.request.token;
}

async function getIndex(handlerInput) {
  // Extracting index from the token received in the request.
  const tokenValue = parseInt(handlerInput.requestEnvelope.request.token, 10);
  const attributes = await handlerInput.attributesManager.getPersistentAttributes();

  return attributes.playbackInfo.playOrder.indexOf(tokenValue);
}

function getOffsetInMilliseconds(handlerInput) {
  // Extracting offsetInMilliseconds received in the request.
  return handlerInput.requestEnvelope.request.offsetInMilliseconds;
}

async function getPlaybackInfo(handlerInput) {
  const attributes = await handlerInput.attributesManager.getPersistentAttributes();
  return attributes.playbackInfo;
}

function shuffleOrder() {
  const array = [...Array(constants.hymns.length).keys()];
  let currentIndex = array.length;
  let temp;
  let randomIndex;
  // Algorithm : Fisher-Yates shuffle
  return new Promise((resolve) => {
    while (currentIndex >= 1) {
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex -= 1;
      temp = array[currentIndex];
      array[currentIndex] = array[randomIndex];
      array[randomIndex] = temp;
    }
    resolve(array);
  });
}

async function canThrowCard(handlerInput) {
  const { requestEnvelope } = handlerInput;
  const playbackInfo = await getPlaybackInfo(handlerInput);

  if (requestEnvelope.request.type === 'IntentRequest' && playbackInfo.playbackIndexChanged) {
    playbackInfo.playbackIndexChanged = false;
    return true;
  }
  return false;
}

const LoadPersistentAttributesRequestInterceptor = {
  async process(handlerInput) {
    const persistentAttributes = await handlerInput.attributesManager.getPersistentAttributes();

    // Check if user is invoking the skill the first time and initialize preset values
    if (Object.keys(persistentAttributes).length === 0) {
      handlerInput.attributesManager.setPersistentAttributes({
        playbackSetting: {
          loop: false,
          shuffle: false,
        },
        playbackInfo: {
          playOrder: [...Array(constants.hymns.length).keys()],
          index: 0,
          offsetInMilliseconds: 0,
          playbackIndexChanged: true,
          token: '',
          nextStreamEnqueued: false,
          inPlaybackSession: false,
          hasPreviousPlaybackSession: false,
        },
      });
    }
  },
};

const SavePersistentAttributesResponseInterceptor = {
  async process(handlerInput) {
    await handlerInput.attributesManager.savePersistentAttributes();
  },
};

/* BUILT-IN INTENT HANDLERS */

const CheckAudioInterfaceHandler = {
  async canHandle(handlerInput) {
    const audioPlayerInterface = ((((handlerInput.requestEnvelope.context || {}).System || {}).device || {}).supportedInterfaces || {}).AudioPlayer;
    return audioPlayerInterface === undefined
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Lo sentimos, este dispositivo no tiene reproductor de audio')
      .withShouldEndSession(true)
      .getResponse();
  },
};

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'LaunchRequest';
  },
  handle(handlerInput) {
    const speechText = 'Bienvenido, prueba pidiendo un himno por número o nombre';
    const reprompt = 'prueba pidiendo un himno por número o nombre';

    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(reprompt)
      .withSimpleCard('', speechText)
      .getResponse();
  },
};

const NextPlaybackHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return playbackInfo.inPlaybackSession
     && (request.type === 'PlaybackController.NextCommandIssued'
     || (request.type === 'IntentRequest' && request.intent.name === 'AMAZON.NextIntent'));
  },
  handle(handlerInput) {
    return controller.playNext(handlerInput);
  },
};

const PreviousPlaybackHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return playbackInfo.inPlaybackSession
    && (request.type === 'PlaybackController.PreviousCommandIssued' || (request.type === 'IntentRequest' && request.intent.name === 'AMAZON.PreviousIntent'));
  },
  handle(handlerInput) {
    return controller.playPrevious(handlerInput);
  },
};

const LoopOnHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return playbackInfo.inPlaybackSession && request.type === 'IntentRequest'
      && request.intent.name === 'AMAZON.LoopOnIntent';
  },
  async handle(handlerInput) {
    const { playbackSetting } = await handlerInput.attributesManager.getPersistentAttributes();

    playbackSetting.loop = true;

    return handlerInput.responseBuilder
      .speak('Bucle encendido.')
      .getResponse();
  },
};

const LoopOffHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return playbackInfo.inPlaybackSession && request.type === 'IntentRequest' && request.intent.name === 'AMAZON.LoopOffIntent';
  },
  async handle(handlerInput) {
    const { playbackSetting } = await handlerInput.attributesManager.getPersistentAttributes();

    playbackSetting.loop = false;

    return handlerInput.responseBuilder
      .speak('Bucle apagado.')
      .getResponse();
  },
};

const ShuffleOnHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return playbackInfo.inPlaybackSession && request.type === 'IntentRequest'
      && request.intent.name === 'AMAZON.ShuffleOnIntent';
  },
  async handle(handlerInput) {
    const {
      playbackInfo,
      playbackSetting,
    } = await handlerInput.attributesManager.getPersistentAttributes();

    playbackSetting.shuffle = true;
    playbackInfo.playOrder = await shuffleOrder();
    playbackInfo.index = 0;
    playbackInfo.offsetInMilliseconds = 0;
    playbackInfo.playbackIndexChanged = true;
    return controller.play(handlerInput);
  },
};

const ShuffleOffHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return playbackInfo.inPlaybackSession
      && request.type === 'IntentRequest'
      && request.intent.name === 'AMAZON.ShuffleOffIntent';
  },
  async handle(handlerInput) {
    const {
      playbackInfo,
      playbackSetting,
    } = await handlerInput.attributesManager.getPersistentAttributes();

    if (playbackSetting.shuffle) {
      playbackSetting.shuffle = false;
      playbackInfo.index = playbackInfo.playOrder[playbackInfo.index];
      playbackInfo.playOrder = [...Array(constants.hymns.length).keys()];
    }

    return controller.play(handlerInput);
  },
};

const StartOverHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return playbackInfo.inPlaybackSession
      && request.type === 'IntentRequest'
      && request.intent.name === 'AMAZON.StartOverIntent';
  },
  async handle(handlerInput) {
    const { playbackInfo } = await handlerInput.attributesManager.getPersistentAttributes();

    playbackInfo.offsetInMilliseconds = 0;

    return controller.play(handlerInput);
  },
};

const YesHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return !playbackInfo.inPlaybackSession
     && request.type === 'IntentRequest'
     && request.intent.name === 'AMAZON.YesIntent';
  },
  handle(handlerInput) {
    return controller.play(handlerInput);
  },
};

const NoHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;

    return !playbackInfo.inPlaybackSession
     && request.type === 'IntentRequest'
     && request.intent.name === 'AMAZON.NoIntent';
  },
  async handle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);

    playbackInfo.index = 0;
    playbackInfo.offsetInMilliseconds = 0;
    playbackInfo.playbackIndexChanged = true;
    playbackInfo.hasPreviousPlaybackSession = false;

    return controller.play(handlerInput);
  },
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'IntentRequest'
      && handlerInput.requestEnvelope.request.intent.name === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    const speechText = 'Puedes pedirme un himno por nombre o número, prueba diciendo: pon el número 203, para navegar entre himnos puedes decir siguiente, anterior y pausa';

    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(speechText)
      .withSimpleCard('Ayuda: ', speechText)
      .getResponse();
  },
};

const CancelAndStopIntentHandler = {
  async canHandle(handlerInput) {
    const playbackInfo = await getPlaybackInfo(handlerInput);
    const { request } = handlerInput.requestEnvelope;


    return !playbackInfo.inPlaybackSession && request.type === 'IntentRequest'
      && (request.intent.name === 'AMAZON.CancelIntent'
        || request.intent.name === 'AMAZON.StopIntent');
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak('Adios!')
      .getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    console.log(`Session ended with reason: ${handlerInput.requestEnvelope.request.reason}`);

    return handlerInput.responseBuilder.getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.log(`Error handled: ${error.message}`);

    return handlerInput.responseBuilder
      .speak('Lo siento, no puedo entenderte, por favor repítelo')
      .reprompt('Lo siento, no puedo entenderte, por favor repítelo')
      .getResponse();
  },
};

const SystemExceptionHandler = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'System.ExceptionEncountered';
  },
  handle(handlerInput) {
    console.log(`System exception encountered: ${handlerInput.requestEnvelope.request.reason}`);
  },
};

const skillBuilder = alexa.SkillBuilders.standard();

exports.handler = skillBuilder
  .addRequestHandlers(
    CheckAudioInterfaceHandler,
    LaunchRequestHandler,
    HelpIntentHandler,
    SystemExceptionHandler,
    SessionEndedRequestHandler,
    YesHandler,
    NoHandler,
    StartPlaybackHandler,
    ResumePlaybackHandler,
    NextPlaybackHandler,
    PreviousPlaybackHandler,
    PausePlaybackHandler,
    LoopOnHandler,
    LoopOffHandler,
    ShuffleOnHandler,
    ShuffleOffHandler,
    StartOverHandler,
    CancelAndStopIntentHandler,
    AudioPlayerEventHandler,
  )
  .addRequestInterceptors(LoadPersistentAttributesRequestInterceptor)
  .addResponseInterceptors(SavePersistentAttributesResponseInterceptor)
  .addErrorHandlers(ErrorHandler)
  .withAutoCreateTable(true)
  .withTableName('alexa-himnos-sud')
  .lambda();
