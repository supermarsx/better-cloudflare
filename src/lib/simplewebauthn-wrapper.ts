import * as swauth from '@simplewebauthn/server';

export let verifyRegistrationResponse = async (...args: any[]) => (swauth as any).verifyRegistrationResponse(...args);
export let verifyAuthenticationResponse = async (...args: any[]) => (swauth as any).verifyAuthenticationResponse(...args);
export let generateRegistrationOptions = (...args: any[]) => (swauth as any).generateRegistrationOptions(...args);
export let generateAuthenticationOptions = (...args: any[]) => (swauth as any).generateAuthenticationOptions(...args);

export default {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
  generateRegistrationOptions,
  generateAuthenticationOptions,
};
