import {Injectable, NgZone, OnDestroy, Optional} from '@angular/core';
import {EMPTY, identity, merge, MonoTypeOperatorFunction, noop, Observable, Observer, of, OperatorFunction, ReplaySubject, share, Subject, TeardownLogic, throwError} from 'rxjs';
import {distinctUntilChanged, filter, finalize, map, mergeMap, take, takeUntil, tap} from 'rxjs/operators';
import {UUID} from '@scion/toolkit/uuid';
import {BrowseOptions, ConsumeOptions, Data, MessageEnvelope, ObserveOptions, PublishOptions, RequestOptions, SolaceMessageClient} from './solace-message-client';
import {TopicMatcher} from './topic-matcher';
import {observeInside} from '@scion/toolkit/operators';
import {SolaceSessionProvider} from './solace-session-provider';
import {SolaceMessageClientConfig} from './solace-message-client.config';
import {Destination, LogLevel, Message, MessageConsumer, MessageConsumerEventName, MessageConsumerProperties, MessageDeliveryModeType, OperationError, QueueBrowser, QueueBrowserEventName, QueueBrowserProperties, QueueDescriptor, QueueType, RequestError, SDTField, SDTFieldType, SDTMapContainer, Session, SessionEvent, SessionEventCode, SessionProperties as SolaceSessionProperties, SessionProperties, SolclientFactory, SolclientFactoryProfiles, SolclientFactoryProperties} from 'solclientjs';
import {TopicSubscriptionCounter} from './topic-subscription-counter';
import {SerialExecutor} from './serial-executor.service';
import './solclientjs-typedef-augmentation';

@Injectable()
export class ɵSolaceMessageClient implements SolaceMessageClient, OnDestroy {

  private _message$ = new Subject<Message>();
  private _event$ = new Subject<SessionEvent>();

  private _session: Promise<Session> | null = null;
  private _destroy$ = new Subject<void>();
  private _sessionDisposed$ = new Subject<void>();

  private _subscriptionExecutor!: SerialExecutor;
  private _subscriptionCounter!: TopicSubscriptionCounter;

  public connected$: Observable<boolean>;

  constructor(@Optional() config: SolaceMessageClientConfig,
              private _sessionProvider: SolaceSessionProvider,
              private _topicMatcher: TopicMatcher,
              private _zone: NgZone) {
    this.initSolaceClientFactory();
    this.disposeWhenSolaceSessionDied();
    this.logSolaceSessionEvents();
    this.connected$ = this.monitorConnectionState$();

    // Auto connect to the Solace broker if having provided a module config.
    if (config) {
      this.connect(config).catch(error => console.error('[SolaceMessageClient] Failed to connect to the Solace message broker.', error));
    }
  }

  public async connect(config: SolaceMessageClientConfig): Promise<void> {
    if (!config) {
      throw Error('[SolaceMessageClient] Missing required config for connecting to the Solace message broker.');
    }

    await (this._session || (this._session = new Promise((resolve, reject) => {
      // Apply session defaults.
      const sessionProperties: SessionProperties = {
        reapplySubscriptions: true, // remember subscriptions after a network interruption (default value if not set)
        reconnectRetries: -1, // Try to restore the connection automatically after a network interruption (default value if not set)
        // @ts-expect-error: typedef(solclientjs): remove when changed 'publisherProperties' to optional
        publisherProperties: undefined,
        ...config,
      };

      this._zone.runOutsideAngular(() => {
        try {
          console.log('[SolaceMessageClient] Connecting to Solace message broker: ', {...sessionProperties, password: '***'});
          this._subscriptionExecutor = new SerialExecutor();
          this._subscriptionCounter = new TopicSubscriptionCounter();

          const session: Session = this._sessionProvider.provide(new SolaceSessionProperties(sessionProperties));

          // When the Session is ready to send/receive messages and perform control operations.
          session.on(SessionEventCode.UP_NOTICE, (event: SessionEvent) => {
            this._event$.next(event);
            resolve(session);
          });

          // When the session has gone down, and an automatic reconnection attempt is in progress.
          session.on(SessionEventCode.RECONNECTED_NOTICE, (event: SessionEvent) => this._event$.next(event));

          // Emits when the session was established and then went down.
          session.on(SessionEventCode.DOWN_ERROR, (event: SessionEvent) => this._event$.next(event));

          // Emits when the session attempted to connect but was unsuccessful.
          session.on(SessionEventCode.CONNECT_FAILED_ERROR, (event: SessionEvent) => {
            this._event$.next(event);
            reject(event);
          });

          // When the session connect operation failed, or the session that was once up, is now disconnected.
          session.on(SessionEventCode.DISCONNECTED, (event: SessionEvent) => this._event$.next(event));

          // When the session has gone down, and an automatic reconnection attempt is in progress.
          session.on(SessionEventCode.RECONNECTING_NOTICE, (event: SessionEvent) => this._event$.next(event));

          // When a direct message was received on the session.
          session.on(SessionEventCode.MESSAGE, (message: Message): void => this._message$.next(message));

          // When a subscribe or unsubscribe operation succeeded.
          session.on(SessionEventCode.SUBSCRIPTION_OK, (event: SessionEvent) => this._event$.next(event));

          // When a subscribe or unsubscribe operation was rejected by the broker.
          session.on(SessionEventCode.SUBSCRIPTION_ERROR, (event: SessionEvent) => this._event$.next(event));

          // When a message published with a guaranteed message delivery strategy, that is {@link MessageDeliveryModeType.PERSISTENT} or {@link MessageDeliveryModeType.NON_PERSISTENT}, was acknowledged by the router.
          session.on(SessionEventCode.ACKNOWLEDGED_MESSAGE, (event: SessionEvent) => this._event$.next(event));

          // When a message published with a guaranteed message delivery strategy, that is {@link MessageDeliveryModeType.PERSISTENT} or {@link MessageDeliveryModeType.NON_PERSISTENT}, was rejected by the router.
          session.on(SessionEventCode.REJECTED_MESSAGE_ERROR, (event: SessionEvent) => this._event$.next(event));

          session.connect();
        }
        catch (e) {
          reject(e);
        }
      });
    })));
  }

  public async disconnect(): Promise<void> {
    const session = await this._session;
    if (!session) {
      return; // already disconnected
    }

    // Disconnect the session gracefully from the Solace event broker.
    // Gracefully means waiting for the 'DISCONNECT' confirmation event before disposing the session,
    // so that the broker can cleanup resources accordingly.
    const whenDisconnected = this.whenEvent(SessionEventCode.DISCONNECTED).then(() => this.dispose());
    this._zone.runOutsideAngular(() => session.disconnect());
    await whenDisconnected;
  }

  private async dispose(): Promise<void> {
    const session = await this._session;
    if (!session) {
      return; // already disposed
    }

    this._session = null;
    this._subscriptionExecutor.destroy();
    this._subscriptionCounter.destroy();
    session.dispose();
    this._sessionDisposed$.next();
  }

  public observe$(topic: string, options?: ObserveOptions): Observable<MessageEnvelope> {
    return new Observable((observer: Observer<MessageEnvelope>): TeardownLogic => {
      const unsubscribe$ = new Subject<void>();
      const topicDestination = createSubscriptionTopicDestination(topic);
      const observeOutsideAngular = options?.emitOutsideAngularZone ?? false;

      // Wait until initialized the session so that 'subscriptionExecutor' and 'subscriptionCounter' are initialized.
      this.session
        .then(() => {
          const subscribeError$ = new Subject<never>();
          let subscriptionErrored = false;

          // Filter messages sent to the given topic.
          merge(this._message$, subscribeError$)
            .pipe(
              assertNotInAngularZone(),
              filter(message => this._topicMatcher.matchesSubscriptionTopic(message.getDestination(), topicDestination)),
              mapToMessageEnvelope(topic),
              observeOutsideAngular ? identity : observeInside(continueFn => this._zone.run(continueFn)),
              takeUntil(merge(this._sessionDisposed$, unsubscribe$)),
              finalize(() => {
                // Unsubscribe from the topic on the Solace session, but only if being the last subscription on that topic and if successfully subscribed to the Solace broker.
                if (this._subscriptionCounter.decrementAndGet(topicDestination) === 0 && !subscriptionErrored) {
                  this.unsubscribeFromTopic(topicDestination).then(noop);
                }
              }),
            )
            .subscribe(observer);

          // Subscribe to the topic on the Solace session, but only if being the first subscription on that topic.
          if (this._subscriptionCounter.incrementAndGet(topicDestination) === 1) {
            this.subscribeToTopic(topicDestination, options).then(success => {
              if (success) {
                options?.onSubscribed?.();
              }
              else {
                subscriptionErrored = true;
                subscribeError$.error(`[SolaceMessageClient] Failed to subscribe to topic ${topicDestination}.`);
              }
            });
          }
          else {
            options?.onSubscribed?.();
          }
        })
        .catch(error => {
          observer.error(error);
        });

      return (): void => unsubscribe$.next();
    });
  }

  /**
   * Subscribes to the given topic on the Solace session.
   */
  private subscribeToTopic(topic: Destination, observeOptions?: ObserveOptions): Promise<boolean> {
    // Calls to `solace.Session.subscribe` and `solace.Session.unsubscribe` must be executed one after the other until the Solace Broker confirms
    // the operation. Otherwise a previous unsubscribe may cancel a later subscribe on the same topic.
    return this._subscriptionExecutor.scheduleSerial(async () => {
      try {
        // IMPORTANT: Do not subscribe when the session is down, that is, after received a DOWN_ERROR. Otherwise, solclientjs would crash.
        // When the session is down, the session Promise resolves to `null`.
        const session = await this._session;
        if (!session) {
          return false;
        }

        const subscribeCorrelationKey = UUID.randomUUID();
        const whenSubscribed = this.whenEvent(SessionEventCode.SUBSCRIPTION_OK, {rejectOnEvent: SessionEventCode.SUBSCRIPTION_ERROR, correlationKey: subscribeCorrelationKey})
          .then(() => true)
          .catch(event => {
            console.warn(`[SolaceMessageClient] Solace event broker rejected subscription on topic ${topic.getName()}.`, event);
            return false;
          });

        session.subscribe(
          topic,
          true,
          subscribeCorrelationKey,
          observeOptions?.subscribeTimeout ?? observeOptions?.requestTimeout,
        );
        return whenSubscribed;
      }
      catch (error) {
        return false;
      }
    });
  }

  /**
   * Unsubscribes from the given topic on the Solace session.
   */
  private unsubscribeFromTopic(topic: Destination): Promise<boolean> {
    // Calls to `solace.Session.subscribe` and `solace.Session.unsubscribe` must be executed one after the other until the Solace Broker confirms
    // the operation. Otherwise a previous unsubscribe may cancel a later subscribe on the same topic.
    return this._subscriptionExecutor.scheduleSerial(async () => {
      try {
        // IMPORTANT: Do not unsubscribe when the session is down, that is, after received a DOWN_ERROR. Otherwise, solclientjs would crash.
        // When the session is down, the session Promise resolves to `null`.
        const session = await this._session;
        if (!session) {
          return false;
        }

        const unsubscribeCorrelationKey = UUID.randomUUID();
        const whenUnsubscribed = this.whenEvent(SessionEventCode.SUBSCRIPTION_OK, {rejectOnEvent: SessionEventCode.SUBSCRIPTION_ERROR, correlationKey: unsubscribeCorrelationKey})
          .then(() => true)
          .catch(event => {
            console.warn(`[SolaceMessageClient] Solace event broker rejected unsubscription on topic ${topic.getName()}.`, event);
            return false;
          });

        session.unsubscribe(
          topic,
          true,
          unsubscribeCorrelationKey,
          undefined,
        );
        return whenUnsubscribed;
      }
      catch (error) {
        return false;
      }
    });
  }

  public consume$(topicOrDescriptor: string | (MessageConsumerProperties & ConsumeOptions)): Observable<MessageEnvelope> {
    if (topicOrDescriptor === undefined) {
      throw Error('[SolaceMessageClient] Missing required topic or endpoint descriptor.');
    }

    // If passed a `string` literal, subscribe to a non-durable topic endpoint.
    if (typeof topicOrDescriptor === 'string') {
      return this.createMessageConsumer$({
        topicEndpointSubscription: SolclientFactory.createTopicDestination(topicOrDescriptor),
        // @ts-expect-error: typedef(solclientjs): remove '@ts-expect-error' when changed 'queueDescriptor' to accept an object literal with 'name' as optional field
        // see 'solclient-fulljs' line 4301 that 'solclientjs' already supports the 'queueDescriptor' to be an object literal with 'name' as optional field. */
        queueDescriptor: {type: QueueType.TOPIC_ENDPOINT, durable: false},
        // @ts-expect-error: typedef(solclientjs): remove 'queueProperties' when changed 'queueProperties' to optional
        queueProperties: undefined,
      });
    }

    return this.createMessageConsumer$(topicOrDescriptor);
  }

  private createMessageConsumer$(consumerProperties: MessageConsumerProperties & ConsumeOptions): Observable<MessageEnvelope> {
    const topicEndpointSubscription = consumerProperties.topicEndpointSubscription?.getName();
    if (topicEndpointSubscription) {
      consumerProperties.topicEndpointSubscription = createSubscriptionTopicDestination(consumerProperties.topicEndpointSubscription!.getName());
    }
    const observeOutsideAngular = consumerProperties?.emitOutsideAngularZone ?? false;

    return new Observable((observer: Observer<Message>): TeardownLogic => {
      let messageConsumer: MessageConsumer | undefined;
      this.session
        .then(session => {
          messageConsumer = session.createMessageConsumer(consumerProperties);

          // Define message consumer event listeners
          messageConsumer.on(MessageConsumerEventName.UP, () => {
            console.debug?.(`[SolaceMessageClient] MessageConsumerEvent: UP`);
            consumerProperties?.onSubscribed?.(messageConsumer!);
          });
          messageConsumer.on(MessageConsumerEventName.CONNECT_FAILED_ERROR, (error: OperationError) => {
            console.debug?.(`[SolaceMessageClient] MessageConsumerEvent: CONNECT_FAILED_ERROR`, error);
            observer.error(error);
          });
          messageConsumer.on(MessageConsumerEventName.DOWN_ERROR, (error: OperationError) => {
            console.debug?.(`[SolaceMessageClient] MessageConsumerEvent: DOWN_ERROR`, error);
            observer.error(error);
          });
          messageConsumer.on(MessageConsumerEventName.DOWN, () => { // event emitted after successful disconnect request
            console.debug?.(`[SolaceMessageClient] MessageConsumerEvent: DOWN`);
            messageConsumer?.dispose();
            observer.complete();
          });

          // Define message event listener
          messageConsumer.on(MessageConsumerEventName.MESSAGE, (message: Message) => {
            console.debug?.(`[SolaceMessageClient] MessageConsumerEvent: MESSAGE`, message);
            NgZone.assertNotInAngularZone();
            observer.next(message);
          });

          // Connect the message consumer
          messageConsumer.connect();
        })
        .catch(error => {
          observer.error(error);
          messageConsumer?.dispose();
        });

      return (): void => {
        // Initiate an orderly disconnection of the consumer. In turn, we will receive a `MessageConsumerEventName#DOWN` event and dispose the consumer.
        // @ts-expect-error: typedef(solclientjs): remove when changed 'MessageConsumer#disposed' from 'void' to 'boolean'
        if (messageConsumer && !messageConsumer.disposed) {
          messageConsumer.disconnect();
        }
      };
    })
      .pipe(
        mapToMessageEnvelope(topicEndpointSubscription),
        observeOutsideAngular ? identity : observeInside(continueFn => this._zone.run(continueFn)),
      );
  }

  public browse$(queueOrDescriptor: string | (QueueBrowserProperties & BrowseOptions)): Observable<MessageEnvelope> {
    if (queueOrDescriptor === undefined) {
      throw Error('[SolaceMessageClient] Missing required queue or descriptor.');
    }

    // If passed a `string` literal, connect to the given queue using default 'browsing' options.
    if (typeof queueOrDescriptor === 'string') {
      return this.createQueueBrowser$({
        queueDescriptor: new QueueDescriptor({type: QueueType.QUEUE, name: queueOrDescriptor}),
      });
    }

    return this.createQueueBrowser$(queueOrDescriptor);
  }

  private createQueueBrowser$(queueBrowserProperties: (QueueBrowserProperties & BrowseOptions)): Observable<MessageEnvelope> {
    const observeOutsideAngular = queueBrowserProperties?.emitOutsideAngularZone ?? false;
    return new Observable((observer: Observer<Message>): TeardownLogic => {
      let queueBrowser: QueueBrowser | undefined;
      let disposed = false;
      this.session
        .then(session => {
          queueBrowser = session.createQueueBrowser(queueBrowserProperties);

          // Define browser event listeners
          queueBrowser.on(QueueBrowserEventName.UP, () => {
            console.debug?.(`[SolaceMessageClient] QueueBrowserEvent: UP`);
            queueBrowser!.start();
          });
          queueBrowser.on(QueueBrowserEventName.CONNECT_FAILED_ERROR, (error: OperationError) => {
            console.debug?.(`[SolaceMessageClient] QueueBrowserEvent: CONNECT_FAILED_ERROR`, error);
            observer.error(error);
          });
          queueBrowser.on(QueueBrowserEventName.DOWN_ERROR, (error: OperationError) => {
            console.debug?.(`[SolaceMessageClient] QueueBrowserEvent: DOWN_ERROR`, error);
            observer.error(error);
          });
          queueBrowser.on(QueueBrowserEventName.DOWN, () => { // event emitted after successful disconnect request
            console.debug?.(`[SolaceMessageClient] QueueBrowserEvent: DOWN`);
            observer.complete();
          });
          queueBrowser.on(QueueBrowserEventName.DISPOSED, () => {
            console.debug?.(`[SolaceMessageClient] QueueBrowserEvent: DOWN`);
            disposed = true;
            observer.complete();
          });

          // Define browser event listener
          queueBrowser.on(QueueBrowserEventName.MESSAGE, (message: Message) => {
            console.debug?.(`[SolaceMessageClient] QueueBrowserEvent: MESSAGE`, message);
            NgZone.assertNotInAngularZone();
            observer.next(message);
          });

          // Connect the browser
          queueBrowser.connect();
        })
        .catch(error => {
          observer.error(error);
        });

      return (): void => {
        // Initiate an orderly disconnection of the browser. In turn, we will receive a `QueueBrowserEventName#DOWN` event and dispose the consumer.
        if (queueBrowser && !disposed) {
          queueBrowser.stop();
          queueBrowser.disconnect();
        }
      };
    })
      .pipe(
        mapToMessageEnvelope(),
        observeOutsideAngular ? identity : observeInside(continueFn => this._zone.run(continueFn)),
      );
  }

  public publish(destination: string | Destination, data?: Data | Message, options?: PublishOptions): Promise<void> {
    const solaceDestination = typeof destination === 'string' ? SolclientFactory.createTopicDestination(destination) : destination;
    const send: Send = (session: Session, message: Message) => session.send(message);
    return this.sendMessage(solaceDestination, data, options, send);
  }

  public request$(destination: string | Destination, data?: Data | Message, options?: RequestOptions): Observable<MessageEnvelope> {
    const observeOutsideAngular = options?.emitOutsideAngularZone ?? false;
    const solaceDestination = typeof destination === 'string' ? SolclientFactory.createTopicDestination(destination) : destination;

    return new Observable<MessageEnvelope>(observer => {
      const unsubscribe$ = new Subject<void>();
      const response$ = new Subject<Message>();
      response$
        .pipe(
          assertNotInAngularZone(),
          mapToMessageEnvelope(),
          observeOutsideAngular ? identity : observeInside(continueFn => this._zone.run(continueFn)),
          takeUntil(unsubscribe$),
        )
        .subscribe(observer);

      const onResponse = (session: Session, message: Message) => {
        response$.next(message);
        response$.complete();
      };
      const onError = (session: Session, error: RequestError) => {
        response$.error(error);
      };

      const send: Send = (session: Session, request: Message) => {
        session.sendRequest(request, options?.requestTimeout, onResponse, onError);
      };
      this.sendMessage(solaceDestination, data, options, send).catch(error => response$.error(error));

      return () => unsubscribe$.next();
    });
  }

  public reply(request: Message, data?: Data | Message, options?: PublishOptions): Promise<void> {
    // "solclientjs" marks the message as 'reply' and copies 'replyTo' destination and 'correlationId' from the request.
    const send: Send = (session: Session, message: Message) => session.sendReply(request, message);
    return this.sendMessage(null, data, options, send);
  }

  public enqueue(queue: string, data?: Data | Message, options?: PublishOptions): Promise<void> {
    const destination = SolclientFactory.createDurableQueueDestination(queue);
    const send: Send = (session: Session, message: Message) => session.send(message);
    return this.sendMessage(destination, data, options, send);
  }

  private async sendMessage(destination: Destination | null, data: ArrayBufferLike | DataView | string | SDTField | Message | undefined, options: PublishOptions | undefined, send: Send): Promise<void> {
    const message: Message = data instanceof Message ? data : SolclientFactory.createMessage();
    message.setDeliveryMode(message.getDeliveryMode() ?? MessageDeliveryModeType.DIRECT);

    // Set the destination. May not be set if replying to a request.
    if (destination) {
      message.setDestination(destination);
    }

    // Set data, either as unstructured byte data, or as structured container if passed a structured data type (SDT).
    if (data !== undefined && data !== null && !(data instanceof Message)) {
      if (data instanceof SDTField) {
        message.setSdtContainer(data);
      }
      else {
        message.setBinaryAttachment(data);
      }
    }

    // Apply publish options.
    if (options) {
      message.setDeliveryMode(options.deliveryMode ?? message.getDeliveryMode());
      message.setCorrelationId(options.correlationId ?? message.getCorrelationId());
      message.setPriority(options.priority ?? message.getPriority());
      message.setTimeToLive(options.timeToLive ?? message.getTimeToLive());
      message.setDMQEligible(options.dmqEligible ?? message.isDMQEligible());
      message.setCorrelationKey(options.correlationKey ?? message.getCorrelationKey());
      options.replyTo && message.setReplyTo(options.replyTo);
      message.setAsReplyMessage(options.markAsReply ?? message.isReplyMessage());
    }

    // Add headers.
    if (options?.headers?.size) {
      const userPropertyMap = (message.getUserPropertyMap() || new SDTMapContainer());
      options.headers.forEach((value, key) => {
        if (value === undefined || value === null) {
          return;
        }
        if (value instanceof SDTField) {
          const sdtField = value;
          userPropertyMap.addField(key, sdtField.getType(), sdtField.getValue());
        }
        else if (typeof value === 'string') {
          userPropertyMap.addField(key, SDTFieldType.STRING, value);
        }
        else if (typeof value === 'boolean') {
          userPropertyMap.addField(key, SDTFieldType.BOOL, value);
        }
        else if (typeof value === 'number') {
          userPropertyMap.addField(key, SDTFieldType.INT32, value);
        }
        else {
          userPropertyMap.addField(key, SDTFieldType.UNKNOWN, value);
        }
      });
      message.setUserPropertyMap(userPropertyMap);
    }

    // Allow intercepting the message before sending it to the broker.
    options?.intercept?.(message);

    const session = await this.session;

    // Publish the message.
    if (message.getDeliveryMode() === MessageDeliveryModeType.DIRECT) {
      send(session, message);
    }
    else {
      const correlationKey = message.getCorrelationKey() || UUID.randomUUID();
      const whenAcknowledged = this.whenEvent(SessionEventCode.ACKNOWLEDGED_MESSAGE, {rejectOnEvent: SessionEventCode.REJECTED_MESSAGE_ERROR, correlationKey: correlationKey});
      message.setCorrelationKey(correlationKey);
      send(session, message);
      // Resolve the Promise when acknowledged by the broker, or reject it otherwise.
      await whenAcknowledged;
    }
  }

  public get session(): Promise<Session> {
    return this._session || Promise.reject('[SolaceMessageClient] Not connected to the Solace message broker. Did you forget to initialize the `SolaceClient` via `SolaceMessageClientModule.forRoot({...}) or to invoke \'connect\'`?');
  }

  /**
   * Returns a Promise that resolves to the event when the expected event occurs, or that rejects when the specified `rejectOnEvent` event, if specified, occurs.
   * If a "correlation key" is specified, only events with that correlation key will be evaluated.
   *
   * Note that:
   * - the Promise resolves or rejects outside the Angular zone
   * - the Promise is bound the current session, i.e., will ony be settled as long as the current session is not disposed.
   */
  private whenEvent(resolveOnEvent: SessionEventCode, options?: { rejectOnEvent?: SessionEventCode; correlationKey?: string | object }): Promise<SessionEvent> {
    return new Promise((resolve, reject) => {
      this._event$
        .pipe(
          assertNotInAngularZone(),
          filter(event => !options?.correlationKey || event.correlationKey === options.correlationKey),
          mergeMap(event => {
            switch (event.sessionEventCode) {
              case resolveOnEvent:
                return of(event);
              case options?.rejectOnEvent: {
                return throwError(() => event);
              }
              default:
                return EMPTY;
            }
          }),
          take(1),
          takeUntil(this._sessionDisposed$),
        )
        .subscribe({
          next: (event: SessionEvent) => resolve(event),
          error: error => reject(error),
          complete: noop, // do not resolve the Promise when the session is disposed
        });
    });
  }

  private initSolaceClientFactory(): void {
    const factoryProperties = new SolclientFactoryProperties();
    factoryProperties.profile = SolclientFactoryProfiles.version10_5;
    factoryProperties.logLevel = LogLevel.INFO;
    SolclientFactory.init(factoryProperties);
  }

  private disposeWhenSolaceSessionDied(): void {
    this._event$
      .pipe(
        filter(event => SESSION_DIED_EVENTS.has(event.sessionEventCode)),
        assertNotInAngularZone(),
        takeUntil(this._destroy$),
      )
      .subscribe(() => {
        this.dispose();
      });
  }

  private logSolaceSessionEvents(): void {
    const sessionEventCodeMapping = Object.entries(SessionEventCode).reduce((acc, [key, value]) => acc.set(value as number, key), new Map<number, string>());
    this._event$
      .pipe(
        assertNotInAngularZone(),
        takeUntil(this._destroy$),
      )
      .subscribe((event: SessionEvent) => {
        console.debug?.(`[SolaceMessageClient] SessionEvent: ${sessionEventCodeMapping.get(event.sessionEventCode)}`, event);
      });
  }

  private monitorConnectionState$(): Observable<boolean> {
    const connected$ = this._event$
      .pipe(
        assertNotInAngularZone(),
        map(event => event.sessionEventCode),
        filter(event => CONNECTION_ESTABLISHED_EVENTS.has(event) || CONNECTION_LOST_EVENTS.has(event)),
        map(event => CONNECTION_ESTABLISHED_EVENTS.has(event)),
        distinctUntilChanged(),
        observeInside(continueFn => this._zone.run(continueFn)),
        share({
          connector: () => new ReplaySubject<boolean>(1),
          resetOnRefCountZero: false,
          resetOnError: false,
          resetOnComplete: false,
        }),
      );
    // Connect to the source, then unsubscribe immediately (resetOnRefCountZero: false)
    connected$.subscribe().unsubscribe();
    return connected$;
  }

  public ngOnDestroy(): void {
    this._destroy$.next();
    this.disconnect().then();
  }
}

/**
 * Maps each {@link Message} to a {@link MessageEnvelope}, and resolves substituted named wildcard segments.
 */
function mapToMessageEnvelope(subscriptionTopic?: string): OperatorFunction<Message, MessageEnvelope> {
  return map((message: Message): MessageEnvelope => {
    return {
      message,
      params: collectNamedTopicSegmentValues(message, subscriptionTopic),
      headers: collectHeaders(message),
    };
  });
}

/**
 * Collects message headers from given message.
 */
function collectHeaders(message: Message): Map<string, any> {
  const userPropertyMap = message.getUserPropertyMap();
  return userPropertyMap?.getKeys().reduce((acc, key) => {
    return acc.set(key, userPropertyMap.getField(key)!.getValue());
  }, new Map()) || new Map();
}

/**
 * Parses the effective message destination for named path segments, if any.
 */
function collectNamedTopicSegmentValues(message: Message, subscriptionTopic: string | undefined): Map<string, string> {
  if (subscriptionTopic === undefined || !subscriptionTopic.length) {
    return new Map<string, string>();
  }

  const subscriptionSegments = subscriptionTopic.split('/');
  const effectiveDestinationSegments = message.getDestination().getName().split('/');
  return subscriptionSegments.reduce((acc, subscriptionSegment, i) => {
    if (isNamedWildcardSegment(subscriptionSegment)) {
      return acc.set(subscriptionSegment.substring(1), effectiveDestinationSegments[i]);
    }
    return acc;
  }, new Map<string, string>());
}

/**
 * Tests whether given segment is a named path segment, i.e., a segment that acts as placeholer for any value, equivalent to the Solace single-level wildcard character (`*`).
 */
function isNamedWildcardSegment(segment: string): boolean {
  return segment.startsWith(':') && segment.length > 1;
}

/**
 * Creates a Solace subscription topic with named topic segments replaced by single-level wildcard characters (`*`), if any.
 */
function createSubscriptionTopicDestination(topic: string): Destination {
  const subscriptionTopic = topic.split('/')
    .map(segment => isNamedWildcardSegment(segment) ? '*' : segment)
    .join('/');
  return SolclientFactory.createTopicDestination(subscriptionTopic);
}

/**
 * Set of events indicating final disconnection from the broker with no recovery possible.
 */
const SESSION_DIED_EVENTS = new Set<number>()
  .add(SessionEventCode.DOWN_ERROR) // is emitted when reaching the limit of connection retries after a connection interruption
  .add(SessionEventCode.DISCONNECTED); // is emitted when disconnected from the session
/**
 * Set of events indicating a connection to be established.
 */
const CONNECTION_ESTABLISHED_EVENTS = new Set<number>()
  .add(SessionEventCode.UP_NOTICE)
  .add(SessionEventCode.RECONNECTED_NOTICE);

/**
 * Set of events indicating a connection to be lost.
 */
const CONNECTION_LOST_EVENTS = new Set<number>()
  .add(SessionEventCode.DOWN_ERROR)
  .add(SessionEventCode.CONNECT_FAILED_ERROR)
  .add(SessionEventCode.DISCONNECTED)
  .add(SessionEventCode.RECONNECTING_NOTICE);

/**
 * Throws if emitting inside the Angular zone.
 */
function assertNotInAngularZone<T>(): MonoTypeOperatorFunction<T> {
  return tap(() => NgZone.assertNotInAngularZone());
}

/**
 * Implements a strategy for sending a message.
 */
type Send = (session: Session, message: Message) => void;
